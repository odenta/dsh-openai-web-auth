/** Informational baseline only: never a runtime compatibility gate. */
export const developedAgainstDsh = '0.2.1-rc.3'

export async function warnVersionDrift(logger, loadRuntime = () => import('@deepseek-ai/dsh-app-boot')) {
  let version
  try {
    const runtime = await loadRuntime()
    // Older runtimes need not expose this helper; detection must not block startup.
    if (typeof runtime.getDshRuntimeVersion !== 'function') return
    version = runtime.getDshRuntimeVersion()
  } catch {
    return
  }
  if (typeof version !== 'string' || !version || version === developedAgainstDsh) return
  logger.warn(`openai-web-auth: DSH version drift: developed against ${developedAgainstDsh}, running ${version}. Compatibility is not guaranteed; continuing without a version restriction.`)
}
