// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { programs } from './programs'
import { documents, issues } from './items'
import { designs } from './designs'
import { vaultFiles } from './vault'
import { users } from './users'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { BomPreview, BomRow, ImportTemplate } from '../../npi/bom'
import type { NpiStage } from '../../npi/domain'

const created = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
// One-to-one NPI extension. Program remains the sole project identity.
export const npiProjects = pgTable('npi_projects', {
  programId: uuid('program_id')
    .primaryKey()
    .references(() => programs.id, { onDelete: 'restrict' }),
  motorModel: varchar('motor_model', { length: 150 }).notNull(),
  technicalOwnerId: uuid('technical_owner_id')
    .notNull()
    .references(() => users.id),
  manufacturingOwnerId: uuid('manufacturing_owner_id')
    .notNull()
    .references(() => users.id),
  drawingCompleteDate: date('drawing_complete_date'),
  requiredKitDate: date('required_kit_date').notNull(),
  prototypeRequiredDate: date('prototype_required_date').notNull(),
  currentNpiStage: varchar('current_npi_stage', { length: 30 })
    .$type<NpiStage>()
    .notNull()
    .default('design'),
  activeBomImportId: uuid('active_bom_import_id').references(
    (): AnyPgColumn => npiBomImports.id,
    { onDelete: 'restrict' },
  ),
  version: integer('version').notNull().default(1),
  createdAt: created(),
})
export const npiUserRoles = pgTable('npi_user_roles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 })
    .$type<
      'technical' | 'manufacturing' | 'procurement' | 'supervisor' | 'admin'
    >()
    .notNull(),
})
export const npiImportTemplates = pgTable('npi_import_templates', {
  id: varchar('id', { length: 100 }).primaryKey(),
  name: text('name').notNull(),
  config: jsonb('config').$type<ImportTemplate>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: created(),
})
// Server-stored, user/project-bound previews; original bytes are kept until
// confirmation and then copied to the immutable import in the same transaction.
export const npiBomPreviews = pgTable('npi_bom_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id')
    .notNull()
    .references(() => programs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  projectVersion: integer('project_version').notNull(),
  templateId: text('template_id').notNull(),
  preview: jsonb('preview').$type<BomPreview>().notNull(),
  sourceName: text('source_name').notNull(),
  sourceBase64: text('source_base64').notNull(),
  sourceHash: text('source_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedImportId: uuid('consumed_import_id'),
  savedAt: timestamp('saved_at', { withTimezone: true }),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
  draftSourceId: uuid('draft_source_id').references(
    (): AnyPgColumn => npiBomPreviews.id,
  ),
  createdAt: created(),
})
export const npiBomImports = pgTable(
  'npi_bom_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    templateId: text('template_id').notNull(),
    mother: jsonb('mother').$type<BomPreview['mother']>().notNull(),
    sheetName: text('sheet_name').notNull(),
    rowCount: integer('row_count').notNull(),
    maxLevel: integer('max_level').notNull(),
    sourceName: text('source_name').notNull(),
    sourceBase64: text('source_base64').notNull(),
    sourceHash: text('source_hash').notNull(),
    templateSnapshot: jsonb('template_snapshot')
      .$type<ImportTemplate>()
      .notNull(),
    importedBy: uuid('imported_by')
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [unique('npi_bom_program_version').on(t.programId, t.versionNo)],
)
export const npiBomItems = pgTable(
  'npi_bom_items',
  {
    id: uuid('id').primaryKey(),
    importId: uuid('import_id')
      .notNull()
      .references(() => npiBomImports.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => npiBomItems.id, {
      onDelete: 'restrict',
    }),
    level: integer('level').notNull(),
    materialCode: text('material_code').notNull(),
    row: jsonb('row').$type<BomRow>().notNull(),
  },
  (t) => [
    index('npi_bom_import_level').on(t.importId, t.level),
    index('npi_bom_parent').on(t.parentId),
  ],
)
export const npiManufacturingPlan = pgTable('npi_manufacturing_plan', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id')
    .notNull()
    .unique()
    .references(() => programs.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
})
export const npiTrackingItems = pgTable(
  'npi_tracking_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    bomItemId: uuid('bom_item_id').references(() => npiBomItems.id, {
      onDelete: 'restrict',
    }),
    manufacturingPlanId: uuid('manufacturing_plan_id').references(
      () => npiManufacturingPlan.id,
      { onDelete: 'cascade' },
    ),
    sourceType: text('source_type').notNull(),
    trackingType: text('tracking_type').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    specification: text('specification').notNull().default(''),
    qty: text('qty').notNull().default('1'),
    unit: text('unit').notNull().default(''),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    requiredDate: date('required_date').notNull(),
    firstCommittedDate: date('first_committed_date'),
    currentCommittedDate: date('current_committed_date'),
    actualCompleteDate: date('actual_complete_date'),
    affectsKit: boolean('affects_kit').notNull().default(true),
    trackingEnabled: boolean('tracking_enabled').notNull().default(true),
    supplier: text('supplier').notNull().default(''),
    remark: text('remark').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    unique('npi_tracking_bom_unique').on(t.bomItemId),
    unique('npi_node_unique').on(t.manufacturingPlanId, t.trackingType),
    index('npi_owner_project').on(t.ownerId, t.programId),
  ],
)
export const npiPromiseHistory = pgTable(
  'npi_promise_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => npiTrackingItems.id, { onDelete: 'restrict' }),
    objectType: text('object_type').notNull(),
    oldCommittedDate: date('old_committed_date'),
    newCommittedDate: date('new_committed_date').notNull(),
    reason: text('reason').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('npi_history_object').on(t.objectId, t.changedAt)],
)
export const npiEvents = pgTable('npi_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').references(() => programs.id, {
    onDelete: 'cascade',
  }),
  objectId: text('object_id').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail').notNull(),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  createdAt: created(),
})

// Native Issue is the sole problem identity and source of lifecycle state.
// This extension only holds NPI scheduling and object associations.
export const npiIssueLinks = pgTable(
  'npi_issue_links',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => issues.itemId, { onDelete: 'restrict' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => npiProjects.programId, { onDelete: 'restrict' }),
    targetDate: date('target_date').notNull(),
    trackingItemId: uuid('tracking_item_id').references(
      () => npiTrackingItems.id,
      { onDelete: 'restrict' },
    ),
    bomItemId: uuid('bom_item_id').references(() => npiBomItems.id, {
      onDelete: 'restrict',
    }),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('npi_issue_project').on(t.programId)],
)

// NPI owns only scope and archive metadata. Bytes and document identity stay native.
export const npiDocumentSpaces = pgTable('npi_document_spaces', {
  programId: uuid('program_id')
    .primaryKey()
    .references(() => npiProjects.programId, { onDelete: 'restrict' }),
  designId: uuid('design_id')
    .notNull()
    .unique()
    .references(() => designs.id, { onDelete: 'restrict' }),
})
export const npiFileLinks = pgTable(
  'npi_file_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => npiProjects.programId, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .unique()
      .references(() => documents.itemId, { onDelete: 'restrict' }),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => vaultFiles.id, { onDelete: 'restrict' }),
    trackingItemId: uuid('tracking_item_id').references(
      () => npiTrackingItems.id,
      { onDelete: 'restrict' },
    ),
    issueId: uuid('issue_id').references(() => npiIssueLinks.itemId, {
      onDelete: 'restrict',
    }),
    category: varchar('category', { length: 30 })
      .$type<'technical' | 'receipt' | 'issue'>()
      .notNull(),
    requestId: uuid('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: created(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => users.id),
    archiveReason: text('archive_reason'),
  },
  (t) => [
    unique('npi_file_upload_request').on(t.uploadedBy, t.requestId),
    index('npi_file_project').on(t.programId),
    index('npi_file_tracking').on(t.trackingItemId),
    index('npi_file_issue').on(t.issueId),
  ],
)
