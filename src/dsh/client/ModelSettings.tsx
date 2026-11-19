import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ResearchChildModel } from '../../core/types.ts'
import type { ChildModelDefaults } from '../child-model.ts'
import type { ModelSettingsSnapshot } from '../model-settings.ts'
import { changedModels, ModelSettingsClient, modelRoles, type ModelRole, type ModelOption, type ModelDetail } from './model-api.ts'
import { modelZh, type ModelTranslate, type ModelCopyKey } from './model-copy.ts'
import { modelStyles } from './model-styles.ts'

/** 一级：五个角色的选择和保存。二级：保存状态、生效范围。三级：只在失败时显示详细原因。 */
export function ModelSettings({ apiBase, t }: { apiBase: string; t: ModelTranslate }) {
  const [client, setClient] = useState<ModelSettingsClient>()
  const [saved, setSaved] = useState<ModelSettingsSnapshot>()
  const [draft, setDraft] = useState<ChildModelDefaults>({})
  const [providers, setProviders] = useState<ModelOption[]>([])
  const [valid, setValid] = useState<Partial<Record<ModelRole, boolean>>>({})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [refreshing, setRefreshing] = useState(true)
  const savedRef = useRef(saved)
  savedRef.current = saved
  useEffect(() => {
    const connection = new ModelSettingsClient(apiBase, t('requestFailed'))
    let active = true
    const previousSaved = savedRef.current
    setClient(connection); setRefreshing(true); setError(undefined); setConfirmed(false)
    void Promise.all([connection.settings(), connection.providers()]).then(([settings, options]) => {
      if (active) {
        setDraft(current => {
          const merged = { ...settings.defaults }
          const edits = previousSaved ? changedModels(previousSaved.defaults, current) : {}
          for (const [role, selection] of Object.entries(edits)) {
            if (selection === null) delete merged[role as ModelRole]
            else merged[role as ModelRole] = selection
          }
          return merged
        })
        setSaved(settings); setProviders(options)
      }
    }).catch(cause => { if (active) setError(String(cause.message ?? cause)) })
      .finally(() => { if (active) setRefreshing(false) })
    return () => { active = false; connection.dispose() }
  }, [apiBase, retry])
  const changes = changedModels(saved?.defaults ?? {}, draft)
  const dirty = Object.keys(changes).length > 0
  const ready = Object.keys(changes).every(role => valid[role as ModelRole])
  const change = (role: ModelRole, selection?: ResearchChildModel) => {
    setDraft(previous => ({ ...previous, [role]: selection })); setConfirmed(false); setError(undefined)
    setValid(previous => ({ ...previous, [role]: selection === undefined }))
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!client || !saved?.editable || !dirty || !ready || saving || refreshing) return
    setSaving(true); setError(undefined); setConfirmed(false)
    try { const updated = await client.save(changes); setSaved(updated); setDraft(updated.defaults); setConfirmed(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <section className="research-models" aria-label={t('title')}>
    <style>{modelStyles}</style>
    <div className="research-models__intro"><p className="research-models__hint">{t('hint')}</p><button type="button" disabled={saving || refreshing} onClick={() => setRetry(value => value + 1)}>{t('refresh')}</button></div>
    {!saved && !error && <p role="status">{t('loading')}</p>}
    {error && <div className="research-models__error" role="alert"><p>{error}</p>{!saved && <button type="button" onClick={() => setRetry(value => value + 1)}>{t('retry')}</button>}</div>}
    {saved && client && <form onSubmit={save} aria-busy={saving}>
      {!saved.editable && <p role="status">{t('readOnly')}</p>}
      {!providers.length && <p role="status">{t('noProviders')}</p>}
      <div className="research-models__rows">{modelRoles.map(role => <ModelRow key={role} role={role} value={draft[role]} providers={providers} client={client} t={t}
        disabled={!saved.editable || saving || refreshing} onChange={selection => change(role, selection)}
        onValid={isValid => setValid(previous => previous[role] === isValid ? previous : ({ ...previous, [role]: isValid }))} />)}</div>
      <footer className="research-models__footer">
        <p role="status" className={confirmed ? 'research-models__success' : ''}>{saving ? t('saving') : refreshing ? t('loading') : confirmed ? t('saved') : dirty ? t('unsaved') : t('unchanged')}</p>
        <div><button type="button" disabled={!dirty || saving || refreshing} onClick={() => { setDraft(saved.defaults); setConfirmed(false); setError(undefined) }}>{t('cancel')}</button>
          <button className="research-panel__primary" type="submit" disabled={!saved.editable || !dirty || !ready || saving || refreshing}>{saving ? t('saving') : t('save')}</button></div>
      </footer>
    </form>}
  </section>
}

function ModelRow({ role, value, providers, client, t, disabled, onChange, onValid }: {
  role: ModelRole; value?: ResearchChildModel; providers: ModelOption[]; client: ModelSettingsClient; t: ModelTranslate;
  disabled: boolean; onChange: (value?: ResearchChildModel) => void; onValid: (valid: boolean) => void;
}) {
  const [options, setOptions] = useState<ModelOption[]>([])
  const [detail, setDetail] = useState<ModelDetail>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const provider = value?.provider ?? '', model = value?.model ?? '', effort = value?.reasoning_effort ?? ''
  useEffect(() => {
    let active = true
    setOptions([]); setDetail(undefined); setError(undefined)
    onValid(!provider)
    if (!provider) { setLoading(false); return }
    setLoading(true)
    void Promise.allSettled([client.models(provider), model ? client.detail(provider, model) : Promise.resolve(undefined)]).then(([catalog, resolved]) => {
      if (active) {
        const models = catalog.status === 'fulfilled' ? catalog.value : []
        const info = resolved.status === 'fulfilled' ? resolved.value : undefined
        setOptions(models); setDetail(info)
        const failure = catalog.status === 'rejected' ? catalog.reason : resolved.status === 'rejected' ? resolved.reason : undefined
        if (failure) setError(String(failure.message ?? failure))
        onValid(!failure && providers.some(option => option.id === provider) && models.some(option => option.id === model)
          && (!effort || !!info?.reasoning?.efforts.some(option => option.id === effort)))
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, provider, model, effort, providers, retry])
  const prefix = `research-model-${role}`
  const efforts = detail?.reasoning?.efforts ?? []
  return <fieldset className="research-models__row" disabled={disabled}>
    <legend>{t(role)}</legend>
    <div className="research-models__fields">
      <label htmlFor={`${prefix}-provider`}><span>{t('provider')}</span><select id={`${prefix}-provider`} value={provider} onChange={event => onChange(event.target.value ? { provider: event.target.value, model: '' } : undefined)}>
        <option value="">{t('inherit')}</option>
        {provider && !providers.some(option => option.id === provider) && <option value={provider}>{provider} · {t('unavailable')}</option>}
        {providers.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}
      </select></label>
      <label htmlFor={`${prefix}-model`}><span>{t('model')}</span><select id={`${prefix}-model`} value={model} disabled={!provider || loading} onChange={event => onChange({ provider, model: event.target.value })}>
        <option value="">{!provider ? t('inherit') : t('choose')}</option>
        {model && !options.some(option => option.id === model) && <option value={model}>{model}{!loading && ` · ${t('unavailable')}`}</option>}
        {options.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}
      </select></label>
      <label htmlFor={`${prefix}-effort`}><span>{t('effort')}</span><select id={`${prefix}-effort`} value={effort} disabled={!model || loading || (!efforts.length && !effort)} onChange={event => onChange({ provider, model, ...(event.target.value ? { reasoning_effort: event.target.value } : {}) })}>
        <option value="">{!provider ? t('inherit') : model && detail && !efforts.length ? t('unsupported') : t('modelDefault')}</option>
        {effort && !efforts.some(option => option.id === effort) && <option value={effort}>{effort}{!loading && ` · ${t('unavailable')}`}</option>}
        {efforts.map(option => <option key={option.id} value={option.id}>{option.id in modelZh ? t(option.id as ModelCopyKey) : option.name || option.id}</option>)}
      </select></label>
    </div>
    {loading && <p className="research-models__row-note" role="status">{t('loadingOptions')}</p>}
    {provider && !loading && !error && !options.length && <p className="research-models__row-note" role="status">{t('noModels')}</p>}
    {error && <div className="research-models__row-note research-models__error" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('retry')}</button></div>}
  </fieldset>
}
