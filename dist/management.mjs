const APPROVED_LISTINGS = new Set(['auto-listed', 'reviewed'])
export const TRUSTED_REPOSITORY_CODE_NOTICE = 'trusted-repository-code'

export function registryEntryGate(entry) {
  if (!APPROVED_LISTINGS.has(entry.listing.state)) return 'approval'
  if (entry.risk.level === 'critical'
    || (entry.listing.state === 'auto-listed' && entry.risk.level === 'high')
    || (entry.install.mode === 'repository-plugin' && entry.listing.state !== 'reviewed')
    || entry.listing.trustedPublisher === 'requested') {
    return 'security'
  }
  return null
}

function capabilities(values) {
  return Object.freeze({
    install: false,
    update: false,
    enable: false,
    disable: false,
    uninstall: false,
    guide: false,
    ...values,
  })
}

export function describeRegistryEntryManagement(entry, hostCapabilities) {
  const gate = registryEntryGate(entry)
  if (gate !== null) {
    return Object.freeze({
      level: 'blocked',
      adapter: entry.install.adapter ?? 'external-guide',
      rollback: 'none',
      gate,
      securityNotice: entry.install.mode === 'repository-plugin' ? TRUSTED_REPOSITORY_CODE_NOTICE : null,
      capabilities: capabilities({ guide: true }),
    })
  }
  if (entry.install.mode === 'profile-bundle') {
    return Object.freeze({
      level: 'transactional',
      adapter: entry.install.adapter,
      rollback: 'generation',
      gate: null,
      securityNotice: null,
      capabilities: capabilities({ install: true, update: true, enable: true, disable: true, uninstall: true, guide: true }),
    })
  }
  if (entry.install.mode === 'repository-plugin') {
    if (hostCapabilities?.repositoryPlugin?.state !== undefined
      && hostCapabilities.repositoryPlugin.state !== 'available') {
      return Object.freeze({
        level: 'guided',
        adapter: 'external-guide',
        rollback: 'none',
        gate: 'host-capability',
        securityNotice: TRUSTED_REPOSITORY_CODE_NOTICE,
        capabilities: capabilities({ guide: true }),
      })
    }
    return Object.freeze({
      level: 'delegated',
      adapter: entry.install.adapter,
      rollback: 'generation',
      gate: null,
      securityNotice: TRUSTED_REPOSITORY_CODE_NOTICE,
      capabilities: capabilities({ install: true, update: true, uninstall: true, guide: true }),
    })
  }
  return Object.freeze({
    level: 'guided',
    adapter: 'external-guide',
    rollback: 'none',
    gate: null,
    securityNotice: null,
    capabilities: capabilities({ guide: true }),
  })
}

function installedManagement(entry) {
  if (entry !== null) {
    const management = describeRegistryEntryManagement(entry)
    const blocked = management.level === 'blocked'
    if (entry.install.mode === 'repository-plugin') {
      return Object.freeze({
        ...management,
        rollback: 'generation',
        capabilities: capabilities({ update: !blocked, uninstall: true, guide: true }),
      })
    }
    return Object.freeze({
      ...management,
      rollback: 'generation',
      capabilities: capabilities({
        update: management.level === 'transactional',
        enable: !blocked,
        disable: true,
        uninstall: true,
        guide: true,
      }),
    })
  }
  return Object.freeze({
    level: 'profile-managed',
    adapter: 'profile',
    rollback: 'generation',
    gate: null,
    securityNotice: null,
    capabilities: capabilities({ enable: true, disable: true, uninstall: true }),
  })
}

export function buildExtensionInventory(profile, registryView, repositorySpecs = [], hostCapabilities) {
  const entries = Array.isArray(registryView?.entries) ? registryView.entries : []
  const byPackageName = new Map(entries
    .filter(entry => entry.install.mode === 'profile-bundle')
    .map(entry => [entry.install.packageName, entry]))
  const byRepositorySpec = new Map(entries
    .filter(entry => entry.install.mode === 'repository-plugin')
    .map(entry => [entry.install.spec, entry]))
  const installedEntryIds = new Set()
  const enabled = new Set(profile?.enabled ?? [])
  const profileInstalled = Object.entries(profile?.installed ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, spec]) => {
      const entry = byPackageName.get(packageName) ?? null
      if (entry !== null) installedEntryIds.add(entry.id)
      return {
        identity: `profile:${packageName}`,
        packageName,
        spec,
        enabled: enabled.has(packageName),
        entry,
        management: installedManagement(entry),
      }
    })
  const repositoryInstalled = repositorySpecs.map((spec) => {
    const entry = byRepositorySpec.get(spec) ?? null
    if (entry !== null) installedEntryIds.add(entry.id)
    const management = entry === null
      ? Object.freeze({
          level: 'delegated',
          adapter: 'official-repository/v1',
          rollback: 'generation',
          gate: null,
          securityNotice: TRUSTED_REPOSITORY_CODE_NOTICE,
          capabilities: capabilities({}),
        })
      : installedManagement(entry)
    return {
      identity: `repository:${entry?.id ?? spec}`,
      packageName: null,
      spec,
      enabled: true,
      entry,
      management,
    }
  })
  const installed = [...profileInstalled, ...repositoryInstalled]
  const available = entries
    .filter(entry => !installedEntryIds.has(entry.id))
    .map(entry => ({ entry, management: describeRegistryEntryManagement(entry, hostCapabilities) }))
  return {
    schema: 'omdsh.extension-inventory/v1',
    profile: profile?.name ?? null,
    installed,
    available,
  }
}
