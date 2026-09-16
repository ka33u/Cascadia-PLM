// SPDX-License-Identifier: AGPL-3.0-or-later
export const moduleInfo = {
  dashboard: {
    label: '首页',
    title: '新品驾驶舱',
    description: '查看项目进度、今日待办和齐套风险。',
  },
  projects: {
    label: '新品项目',
    title: '新品项目',
    description: '按阶段管理新品计划、负责人和样机目标。',
  },
  bom: {
    label: 'BOM管理',
    title: 'BOM管理',
    description: '按项目导入ERP BOM、查看完整结构与历史版本。',
  },
  manufacturing: {
    label: '制造准备',
    title: '制造准备',
    description:
      '集中跟进工艺、工装、零部件齐套和样机装配，回复日期并确认完成。',
  },
  purchasing: {
    label: '采购管理',
    title: '采购管理',
    description: '查看采购物料交期、责任人和到货进展。',
  },
  reports: {
    label: '报表看板',
    title: '报表看板',
    description: '查看阶段分布、样机完成结果和承诺变更。',
  },
  data: {
    label: '基础数据',
    title: '基础数据',
    description: '维护BOM导入模板，查看阶段和制造节点定义。',
  },
  settings: {
    label: '系统设置',
    title: '系统设置',
    description: '分配NPI业务岗位，管理系统用户。',
  },
  procurement: {
    label: '采购管理',
    title: '我的采购任务',
    description: '回复本人采购件交期、说明改期原因、确认到货。',
  },
} as const
export type ModuleId = keyof typeof moduleInfo
export function navigationFor(role: string): Array<ModuleId> {
  if (role === 'procurement') return ['procurement']
  return [
    'dashboard',
    'projects',
    'bom',
    'manufacturing',
    'purchasing',
    'reports',
    ...(role === 'admin' ? (['data', 'settings'] as const) : []),
  ]
}
export const stageLabels: Record<string, string> = {
  design: '设计中',
  manufacturing: '制造准备',
  prototype: '样机制作',
  test: '样机试验',
  completed: '完成',
}
export const stateLabels: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '已完成',
}
