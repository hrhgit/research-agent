export const modelZh = {
  overview: '研究概览', title: '子智能体模型', hint: '设置各角色的默认模型。保存后用于新派工，已有子任务保留原选择。',
  provider: '服务商', model: '模型', effort: '思考强度', inherit: '跟随主会话', choose: '请选择模型',
  modelDefault: '模型默认', unsupported: '此模型不支持调整', unavailable: '当前不可用',
  loading: '正在读取模型设置…', loadingOptions: '正在读取选项…', retry: '重试', refresh: '刷新选项', save: '保存设置', saving: '正在保存…',
  saved: '已保存，新派工立即生效。', unchanged: '设置已同步', unsaved: '有未保存的修改', cancel: '撤销修改',
  readOnly: '当前环境不能保存配置；已有设置仍可查看。', noProviders: '还没有可用的模型服务商，请先在 DSH 设置中添加。',
  noModels: '此服务商暂无可选模型，请先在 DSH 设置中配置。',
  requestFailed: '无法读取或保存模型设置，请重试。', incomplete: '请先完成模型选择。',
  scout: '侦察', runner: '执行', auditor: '复核', synthesizer: '汇总', 'tool-engineer': '工具维护',
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高',
}
export type ModelCopyKey = keyof typeof modelZh
export type ModelTranslate = (key: ModelCopyKey) => string
export const modelEn: Record<ModelCopyKey, string> = {
  overview: 'Research overview', title: 'Subagent models', hint: 'Choose defaults for each role. Saved changes apply to new assignments; existing tasks keep their model.',
  provider: 'Provider', model: 'Model', effort: 'Reasoning effort', inherit: 'Follow main session', choose: 'Choose a model',
  modelDefault: 'Model default', unsupported: 'Not adjustable for this model', unavailable: 'Unavailable',
  loading: 'Loading model settings…', loadingOptions: 'Loading options…', retry: 'Retry', refresh: 'Refresh options', save: 'Save settings', saving: 'Saving…',
  saved: 'Saved. New assignments use these defaults immediately.', unchanged: 'Settings are up to date', unsaved: 'Unsaved changes', cancel: 'Discard changes',
  readOnly: 'Settings are read-only in this environment.', noProviders: 'No model providers are available. Add one in DSH settings first.',
  noModels: 'This provider has no available models. Configure it in DSH settings first.',
  requestFailed: 'Could not load or save model settings. Please retry.', incomplete: 'Complete the model selections first.',
  scout: 'Scout', runner: 'Runner', auditor: 'Auditor', synthesizer: 'Synthesizer', 'tool-engineer': 'Tool engineer',
  none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', ultra: 'Ultra',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'research.models': ModelCopyKey }
}
