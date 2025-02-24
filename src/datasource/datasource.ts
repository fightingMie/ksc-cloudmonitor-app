import { DataQueryRequest, DataQueryResponse, DataSourceApi, MetricFindValue } from '@grafana/data';
import { MyQuery, MyDataSourceOptions, defaultQuery } from './types';
import {
  request,
  ParseQueryResult,
  ParseMetricQuery,
  variableConfig,
  replaceRealValue,
  withoutRegions,
  GenerateKs3ToMonitorRegion,
  requestKs3,
} from './utils';
import { EbsInstanceItem, MetricListItem } from './utils/interface';
import _ from 'lodash';
import { statisMetric, statisMetricBatch } from './services';
const moment = require('moment');

function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true; // 解析成功，是有效的JSON字符串
  } catch {
    return false; // 解析失败，不是有效的JSON字符串
  }
}
// quer界面需要解析的参数
// Region 区域
// Action 产品线接口参数
// ServiceName 产品线名称
// Instancealias Query变量显示别名
const filterQueryKeys = ['Region', 'Action', 'ServiceName', 'Instancealias'];

// 生成get请求参数
const generateExtenQuery = (queryResult: { [key: string]: any }) => {
  let otherUrl = '';
  for (const key in queryResult) {
    if (!filterQueryKeys.includes(key)) {
      const queryValue = replaceRealValue(queryResult[key]);
      otherUrl += `&${key}=${queryValue}`;
    }
  }
  return otherUrl;
};

const generateEbsInstanceExtenQuery = (queryResult: { [key: string]: any }) => {
  let obj: { [key: string]: any } = {};
  for (const key in queryResult) {
    if (!filterQueryKeys.includes(key)) {
      const queryValue = replaceRealValue(queryResult[key]);
      obj[key] = queryValue;
    }
  }
  return obj;
};

// 生成请求实例ID
const generateInstanceIdList = (InstanceID: Array<{ label: string; value: string; [keyname: string]: any }>) => {
  let dealId = [];
  if (InstanceID?.length > 1) {
    dealId = Array.isArray(InstanceID) ? InstanceID.map((i: any) => replaceRealValue(i?.value)) : [];
  } else {
    dealId = Array.isArray(InstanceID) ? replaceRealValue(InstanceID[0]?.value).split(',') : [];
  }
  dealId = dealId.filter((instanceItem: string) => instanceItem && instanceItem !== '');
  return dealId;
};

// 生成EBS 请求实例
const generateEbsInstance = (
  InstanceID: Array<{ label: string; value: string; [keyname: string]: any }>
): EbsInstanceItem[] => {
  const realInstance = Array.isArray(InstanceID)
    ? InstanceID.map((i: any) => {
        const realI = replaceRealValue(i?.value);
        return JSON.parse(`{${realI}}`);
      })
    : [];
  return realInstance;
};
// 根据获取的指标列表，获取指标的盘符列表
const generateDevices = (metricList: any[]) => {
  if (!metricList || !metricList?.length) return [];
  const deviceList = metricList
    .filter((i: any) => !i.metricName.includes('system.hw.diskuuid'))
    .map((i: any) => i.metricName.match(/\[(.*?)\]/)[1]);
  return deviceList;
};

export const getEbsMetricNames = async (defaultExtenQuery: string, instanceSetting: any, Region: string) => {
  const metricNamesData: any = await request(instanceSetting, `monitor`, {
    action: 'ListMetrics',
    version: '2010-05-25',
    extenQuery: defaultExtenQuery,
    region: replaceRealValue(Region),
  });
  return metricNamesData?.data?.listMetricsResult?.metrics?.member;
};

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  instanceSetting: any;
  backendSrv: any;
  templateSrv: any;
  url: string;

  constructor(instanceSettings: any, backendSrv: any, templateSrv: any) {
    super(instanceSettings);
    this.instanceSetting = instanceSettings;
    this.backendSrv = backendSrv;
    this.templateSrv = templateSrv;
    this.url = instanceSettings.url; // 代理url
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    // 8小时
    const hours = 28800000;
    const { range, targets } = options;
    const from = range!.from.valueOf() + hours;
    const to = range!.to.valueOf() + hours;
    const StartTime = moment.utc(from).format();
    const EndTime = moment.utc(to).format();
    let errorlist: any = [];

    const requestTargets = targets.filter(
      (item) =>
        Array.isArray(item?.InstanceID) &&
        item.InstanceID.length > 0 &&
        item.MetricName?.value &&
        item.Namespace?.value &&
        item.Region?.value &&
        !item.hide
    );

    if (!requestTargets.length) {
      return { data: [] };
    }
    const queryResult = await Promise.allSettled(
      requestTargets.map(async (item) => {
        const { InstanceID, MetricName, Namespace, Period, Aggregate, Region } = item;
        const NameSpace = Namespace?.value;
        const aggregateValues = Aggregate ? Aggregate : defaultQuery.Aggregate;
        const aggregates = aggregateValues.map((i: any) => i.value);
        const dealId: string[] = generateInstanceIdList(InstanceID);
        const dealMetricName = replaceRealValue(MetricName?.value);
        const dealRegion = replaceRealValue(Region.value);
        const { action, version, method } = NameSpace === 'KCE' ? statisMetric : statisMetricBatch;
        const queryDataparams = {
          Namespace: NameSpace,
          Aggregate: aggregates?.length ? aggregates : ['Average'],
          StartTime,
          EndTime,
        };
        if (!dealId?.length) {
          return {};
        }
        if (Period?.value) {
          const dealPeriod = replaceRealValue(String(Period?.value));
          _.set(queryDataparams, 'Period', Number(dealPeriod));
        }
        if (NameSpace === 'KCE') {
          const extenUrl = generateExtenQuery(queryDataparams);
          return request(this.instanceSetting, `monitor`, {
            action,
            version,
            extenQuery: `${extenUrl}&MetricName=${dealMetricName}&Dimensions.0.Name=ClusterId&Dimensions.0.Value=${dealId[0]}`,
            method,
            region: dealRegion,
          });
        } else if (NameSpace === 'KS3') {
          _.set(
            queryDataparams,
            'Metrics',
            dealId.map((instanceItem: any) => ({
              InstanceID: instanceItem,
              MetricName: dealMetricName,
            }))
          );
          return request(this.instanceSetting, `monitor`, {
            action,
            version,
            postParams: { ...queryDataparams },
            method,
            region: GenerateKs3ToMonitorRegion(dealRegion),
          });
        } else if (NameSpace === 'EBS') {
          const dealEbsIds = generateEbsInstance(InstanceID);
          const realInstanceItem = replaceRealValue(InstanceID?.[0]?.value);
          const { InstanceId, VolumeId, MountPoint } = JSON.parse(`{${realInstanceItem}}`) || {};
          let defaultExtenQuery = `&Dimensions.0.Name=VolumeId&Dimensions.0.Value=${VolumeId}&Namespace=KEC/EBS&PageIndex=1&InstanceId=${InstanceId}`;
          let metricList = await getEbsMetricNames(defaultExtenQuery, this.instanceSetting, dealRegion);
          if (!metricList || !metricList?.length) {
            defaultExtenQuery += `&Dimensions.1.Name=MountPoint&Dimensions.1.Value=${MountPoint}`;
            metricList = await getEbsMetricNames(defaultExtenQuery, this.instanceSetting, dealRegion);
          }
          const deviceList = _.uniq(generateDevices(metricList));
          _.set(
            queryDataparams,
            'Metrics',
            deviceList.map((device: string) => ({
              InstanceID: dealEbsIds[0].InstanceId,
              MetricName: `${dealMetricName}[${device}]`,
            }))
          );
          _.set(queryDataparams, 'Namespace', 'KEC/EBS');
          return request(this.instanceSetting, `monitor`, {
            action,
            version,
            postParams: { ...queryDataparams },
            method,
            region: dealRegion,
          });
        } else {
          _.set(
            queryDataparams,
            'Metrics',
            dealId.map((instanceItem: any) => ({
              InstanceID: instanceItem,
              MetricName: dealMetricName,
            }))
          );
          return request(this.instanceSetting, `monitor`, {
            action,
            version,
            postParams: { ...queryDataparams },
            method,
            region: dealRegion,
          });
        }
      })
    )
      .then((res: any[]) => {
        const fulfilledRes = res.filter((i: any) => i.status === 'fulfilled');
        const result = fulfilledRes.map((item: any, index: number) => {
          if (item?.value?.data?.errorMessage || item.value.data?.error) {
            errorlist.push(item?.value?.data?.errorMessage || item.value.data?.error?.message);
          }
          const dealData =
            item.value.data?.getMetricStatisticsBatchResults || item.value.data?.getMetricStatisticsResult;
          return ParseQueryResult(dealData, requestTargets[index]);
        });
        return { data: _.flatten(result) };
      })
      .catch((err) => {
        return { data: [] };
      });
    // if (errorlist && errorlist?.length > 0) {
    //   const errorMessage = _.flatten(errorlist).join(',');
    //   alertError(errorMessage);
    // }
    return queryResult;
  }

  async testDatasource() {
    // 根据region 判断key 是否正确
    const testRegion: any = await this.getRegions();
    if (testRegion?.status === 200) {
      return {
        status: 'success',
        message: 'test success',
      };
    } else {
      return {
        status: 'error',
        message: `数据源测试失败${testRegion?.data?.Error.Message}`,
      };
    }
  }

  // 自定义变量回调函数
  async metricFindQuery(query: string, options?: any): Promise<MetricFindValue[]> {
    const queryResult = ParseMetricQuery(query);
    const { Region, Action, Instancealias = undefined, ServiceName } = queryResult;
    if (!ServiceName) {
      return [];
    }
    // 查询指标接口
    if (Action === 'ListMetrics' && ServiceName === 'Monitor') {
      const { InstanceItem, Region } = generateEbsInstanceExtenQuery(queryResult);
      if (!isValidJSON(InstanceItem)) {
        console.error('选择实例后为获取到JSON数据');
      }
      const { InstanceId, VolumeId, MountPoint } = JSON.parse(`{${InstanceItem}}`) || {};
      let defaultExtenQuery = `&Dimensions.0.Name=VolumeId&Dimensions.0.Value=${VolumeId}&Namespace=KEC/EBS&PageIndex=1&InstanceId=${InstanceId}`;
      let metricList = await getEbsMetricNames(defaultExtenQuery, this.instanceSetting, Region);
      if (!metricList || !metricList?.length) {
        defaultExtenQuery += `&Dimensions.1.Name=MountPoint&Dimensions.1.Value=${MountPoint}`;
        metricList = await getEbsMetricNames(defaultExtenQuery, this.instanceSetting, Region);
      }
      if (metricList && metricList?.length) {
        const deviceList = metricList
          .filter((i: any) => !i.metricName.includes('system.hw.diskuuid'))
          .map((i: any) => ({
            label: i.metricName.match(/\[(.*?)\]/)[1],
            value: i.metricName.match(/\[(.*?)\]/)[1],
          }));
        return deviceList;
      }
      return [];
    }

    // k3自定义变量接口处理
    if (ServiceName === 'KS3') {
      const ks3Region = replaceRealValue(Region);
      const ks3QueryResult: any = await requestKs3(this.instanceSetting, `ks3/${ks3Region}`, {
        region: ks3Region,
        extenQuery: generateExtenQuery(queryResult),
      });
      return ks3QueryResult;
    }
    const service = variableConfig[ServiceName] ? variableConfig[ServiceName].service : undefined;
    const currentMap = variableConfig[ServiceName][Action];
    const proxyKey = withoutRegions.includes(service)
      ? replaceRealValue(service)
      : `${replaceRealValue(service)}/${replaceRealValue(Region)}`;
    // 其他服务变量接口处理
    const doQueryResult: any = await request(this.instanceSetting, proxyKey, {
      action: Action,
      version: currentMap?.version,
      region: replaceRealValue(Region),
      extenQuery: generateExtenQuery(queryResult),
    });
    const resList: any[] = doQueryResult?.data[currentMap?.getDataKey] || [];
    const dealResList: MetricListItem[] = currentMap.backDataFn(resList, Instancealias);
    return dealResList;
  }

  getVariable(metric?: string) {
    const rs = this.templateSrv.replace((metric || '').trim());
    const valStr = rs.match(/\{([\w-,]+)\}/);
    // 判断是否为多选
    if (valStr) {
      return valStr[1].split(',');
    }
    return rs;
  }
  // 获取region
  async getRegions() {
    return request(this.instanceSetting, 'kec', {
      action: 'DescribeRegions',
      version: '2016-03-04',
    });
  }
}
