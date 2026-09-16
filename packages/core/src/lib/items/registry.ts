// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { resolveLifecycleType } from '../lifecycles/normalize'
import type { ItemTypeConfig, StateConfig } from './types/base'
import type { RuntimeItemTypeConfig } from './types/runtime-config'
import type { LifecycleDefinition } from '../lifecycles/types'
import type { ConfigService as ConfigServiceType } from '../config'
import type { LifecycleDefinitionService as LifecycleDefinitionServiceType } from '../lifecycles/LifecycleDefinitionService'

// Re-export for convenience
export type { RuntimeItemTypeConfig } from './types/runtime-config'

// Lazy import of ConfigService to avoid bundling database code in client
// This is only used on the server in loadRuntimeConfigs()
let ConfigServiceCache: typeof ConfigServiceType | null = null
async function getConfigService() {
  if (!ConfigServiceCache) {
    const module = await import('../config')
    ConfigServiceCache = module.ConfigService
  }
  return ConfigServiceCache
}

// Lazy import of LifecycleDefinitionService for lifecycle lookups
let LifecycleDefinitionServiceCache:
  typeof LifecycleDefinitionServiceType | null = null
async function getLifecycleDefinitionService() {
  if (!LifecycleDefinitionServiceCache) {
    const module = await import('../lifecycles/LifecycleDefinitionService')
    LifecycleDefinitionServiceCache = module.LifecycleDefinitionService
  }
  return LifecycleDefinitionServiceCache
}

/**
 * Central registry for all item types in the PLM system.
 *
 * Implements a two-tier configuration pattern:
 * - Code definitions: Type-safe configs defined in code (schema, components, table)
 * - Runtime configs: Business rules from database (permissions, labels, states)
 *
 * Runtime configs override code defaults for configurable fields.
 * Components and schemas always come from code for type safety.
 */
class ItemTypeRegistry {
  /** Code-defined item type configurations */
  private static codeDefinitions = new Map<string, ItemTypeConfig>()

  /** Runtime configurations loaded from database */
  private static runtimeConfigs = new Map<string, RuntimeItemTypeConfig>()

  /** Merged configurations (cached for performance) */
  private static mergedCache = new Map<string, ItemTypeConfig>()

  /**
   * The definition assigned to each item type, whatever its kind.
   *
   * Every `LifecycleService` question — "what state does release produce",
   * "what revision scheme", "is this action valid" — resolves through
   * `getAssignedDefinitionForType`, which was a fresh `SELECT` of the same
   * workflow-definition row each time. A change-order release asks ~30 of them,
   * most inside per-item loops, so a 50-item release did on the order of 250
   * redundant queries while holding a serializable transaction open.
   *
   * A definition cannot change mid-request, and every path that edits one
   * already invalidates here: `reload()` (admin item-type edits and the test
   * fixtures), `LifecycleDefinitionService.create/update/delete` (lifecycle edits), and
   * `unregister`/`clear`. `undefined` is cached too — "nothing assigned" is
   * asked about just as often. Driving definitions are cached like any other
   * and filtered out on read by `getLifecycleForType`; a lookup that throws
   * caches nothing, so the next caller asks the database again.
   */
  private static lifecycleCache = new Map<
    string,
    LifecycleDefinition | undefined
  >()

  /** Whether runtime configs have been loaded */
  private static isInitialized = false

  /** Initialization promise to prevent duplicate loads */
  private static initPromise: Promise<void> | null = null

  /**
   * Register a new item type configuration from code.
   * This defines the base configuration including schema and components.
   */
  static register<T = any>(config: ItemTypeConfig<T>): void {
    this.codeDefinitions.set(config.name, config)
    // Invalidate merged cache for this type
    this.mergedCache.delete(config.name)
    this.lifecycleCache.delete(config.name)
  }

  /**
   * Drop the memoized lifecycle definitions.
   *
   * Called from every path that can change one: this registry's own reload, and
   * `LifecycleDefinitionService.create/update/delete`. A lifecycle edit that does not land
   * here would be invisible until the process restarted.
   */
  static invalidateLifecycleCache(): void {
    this.lifecycleCache.clear()
  }

  /**
   * Load runtime configurations from the database.
   * Called during server initialization.
   */
  static async loadRuntimeConfigs(): Promise<void> {
    try {
      const configService = await getConfigService()
      const configs = await configService.getAllConfigs()

      this.runtimeConfigs.clear()
      this.mergedCache.clear()
      this.lifecycleCache.clear()

      for (const config of configs) {
        this.runtimeConfigs.set(config.itemType, config.config)
      }
    } catch (error) {
      // Log but don't fail - code defaults will be used
      console.error('[ItemTypeRegistry] Failed to load runtime configs:', error)
    }
  }

  /**
   * Initialize the registry by loading runtime configurations.
   * Safe to call multiple times - will only load once.
   */
  static async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Prevent duplicate initialization
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.loadRuntimeConfigs()
      .then(() => {
        this.isInitialized = true
      })
      .catch((error) => {
        // Mark as initialized even on failure to prevent retry loops
        this.isInitialized = true
        console.error(
          '[ItemTypeRegistry] Initialization failed, using code defaults:',
          error,
        )
      })
      .finally(() => {
        this.initPromise = null
      })

    return this.initPromise
  }

  /**
   * Merge code definition with runtime configuration.
   * Runtime values override code defaults for configurable fields.
   * Components and schema always come from code.
   */
  private static mergeConfigs(
    codeConfig: ItemTypeConfig,
    runtimeConfig?: RuntimeItemTypeConfig,
  ): ItemTypeConfig {
    if (!runtimeConfig) {
      return codeConfig
    }

    return {
      // Always from code (type safety)
      name: codeConfig.name,
      schema: codeConfig.schema,
      table: codeConfig.table,
      components: codeConfig.components,
      searchableFields: codeConfig.searchableFields,
      displayField: codeConfig.displayField,
      states: codeConfig.states, // Deprecated: states now come from lifecycle definition

      // Runtime overrides code defaults
      label: runtimeConfig.label ?? codeConfig.label,
      pluralLabel: runtimeConfig.pluralLabel ?? codeConfig.pluralLabel,
      icon: runtimeConfig.icon ?? codeConfig.icon,
      lifecycleDefinitionId:
        runtimeConfig.lifecycleDefinitionId ?? codeConfig.lifecycleDefinitionId,
      permissions: runtimeConfig.permissions ?? codeConfig.permissions,
      relationships: runtimeConfig.relationships ?? codeConfig.relationships,
    }
  }

  /**
   * Get configuration for a specific item type.
   * Returns merged config (runtime overrides code defaults).
   */
  static getType(name: string): ItemTypeConfig | undefined {
    // Check cache first
    if (this.mergedCache.has(name)) {
      return this.mergedCache.get(name)
    }

    const codeConfig = this.codeDefinitions.get(name)
    if (!codeConfig) {
      return undefined
    }

    const runtimeConfig = this.runtimeConfigs.get(name)
    const merged = this.mergeConfigs(codeConfig, runtimeConfig)

    // Cache the merged result
    this.mergedCache.set(name, merged)
    return merged
  }

  /**
   * Get all registered item types (merged configurations)
   */
  static getAllTypes(): Array<ItemTypeConfig> {
    return Array.from(this.codeDefinitions.keys())
      .map((name) => this.getType(name)!)
      .filter(Boolean)
  }

  /**
   * Check if an item type is registered
   */
  static hasType(name: string): boolean {
    return this.codeDefinitions.has(name)
  }

  /**
   * Get item types that can be created by a user with specific roles
   */
  static getTypesForRoles(roles: Array<string>): Array<ItemTypeConfig> {
    return this.getAllTypes().filter((type) => {
      return type.permissions.create.some(
        (permission) => permission === '*' || roles.includes(permission),
      )
    })
  }

  /**
   * Reload runtime configurations from database.
   * Call this after updating configurations via admin UI.
   */
  static async reload(): Promise<void> {
    this.isInitialized = false
    await this.loadRuntimeConfigs()
    this.isInitialized = true
  }

  /**
   * Get only the runtime configuration for an item type (if any)
   */
  static getRuntimeConfig(name: string): RuntimeItemTypeConfig | undefined {
    return this.runtimeConfigs.get(name)
  }

  /**
   * Get only the code definition for an item type
   */
  static getCodeDefinition(name: string): ItemTypeConfig | undefined {
    return this.codeDefinitions.get(name)
  }

  /**
   * Check if runtime configs have been loaded
   */
  static isReady(): boolean {
    return this.isInitialized
  }

  /**
   * Unregister an item type (mainly for testing)
   */
  static unregister(name: string): boolean {
    this.codeDefinitions.delete(name)
    this.runtimeConfigs.delete(name)
    this.mergedCache.delete(name)
    this.lifecycleCache.delete(name)
    return true
  }

  /**
   * Clear all registered types (mainly for testing)
   */
  static clear(): void {
    this.codeDefinitions.clear()
    this.runtimeConfigs.clear()
    this.mergedCache.clear()
    this.lifecycleCache.clear()
    this.isInitialized = false
    this.initPromise = null
  }

  // ============================================
  // Lifecycle Resolution Methods
  // ============================================

  /**
   * Get the lifecycle definition ID for an item type.
   * Returns undefined if no lifecycle is assigned.
   */
  static getLifecycleDefinitionId(itemType: string): string | undefined {
    const config = this.getType(itemType)
    return config?.lifecycleDefinitionId
  }

  /**
   * The definition assigned to an item type, whatever its kind: the item
   * lifecycle of a Driven or Free type, or the change-order workflow of a
   * Driving one. `undefined` when the type has nothing assigned or the
   * assigned id matches no row.
   *
   * A failed lookup throws. It used to be caught, logged and answered as
   * `undefined`, which made "the database could not answer" the same answer
   * as "nothing assigned" — and `LifecycleService.getLifecycleType` turned
   * that into `'Free'`, the one kind branch protection exempts, so a transient
   * error while loading a Part's lifecycle let a direct write through to a
   * protected main. Nothing here decides what a missing answer means; every
   * consumer fails closed on the error instead.
   */
  static async getAssignedDefinitionForType(
    itemType: string,
  ): Promise<LifecycleDefinition | undefined> {
    if (this.lifecycleCache.has(itemType)) {
      return this.lifecycleCache.get(itemType)
    }

    const lifecycleId = this.getLifecycleDefinitionId(itemType)
    if (!lifecycleId) {
      this.lifecycleCache.set(itemType, undefined)
      return undefined
    }

    const definitions = await getLifecycleDefinitionService()
    const definition = (await definitions.getById(lifecycleId)) ?? undefined
    this.lifecycleCache.set(itemType, definition)
    return definition
  }

  /**
   * Get the lifecycle definition for an item type: the assigned definition
   * when it is an item lifecycle (Driven or Free). Change-order workflows —
   * Driving definitions — never resolve as an item's lifecycle, so a type
   * governed by one answers `undefined` here; `getAssignedDefinitionForType`
   * returns the definition itself.
   */
  static async getLifecycleForType(
    itemType: string,
  ): Promise<LifecycleDefinition | undefined> {
    const definition = await this.getAssignedDefinitionForType(itemType)
    return definition && resolveLifecycleType(definition) !== 'Driving'
      ? definition
      : undefined
  }

  /**
   * Get the valid states for an item type from its lifecycle definition.
   * Every state an item of the type can hold, resolved through the lifecycle
   * service: a Driving-governed type (ChangeOrder) gets the union across the
   * definitions its change types run. There is no code-defined fallback any
   * more — it answered for ChangeOrder, because the registry deliberately
   * never resolves a Driving definition as an item lifecycle, with a list of
   * states no change order could hold.
   */
  static async getStatesForType(itemType: string): Promise<Array<StateConfig>> {
    const { LifecycleService } = await import('../services/LifecycleService')
    return (await LifecycleService.getRenderableStates(itemType)).map(
      (state) => ({
        id: state.id,
        name: state.name,
        color: state.color,
        description: state.description,
      }),
    )
  }

  /**
   * Get all item types that use a specific lifecycle definition.
   * Used for validation when modifying or deleting a lifecycle.
   */
  static getItemTypesUsingLifecycle(
    lifecycleDefinitionId: string,
  ): Array<string> {
    const itemTypes: Array<string> = []

    for (const [name, _] of this.codeDefinitions) {
      const config = this.getType(name)
      if (config?.lifecycleDefinitionId === lifecycleDefinitionId) {
        itemTypes.push(name)
      }
    }

    return itemTypes
  }
}

export { ItemTypeRegistry }
