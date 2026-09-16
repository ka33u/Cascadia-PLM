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
import { projects } from './projects'
import { users } from './users'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { BomPreview, BomRow, ImportTemplate } from '../../npi/bom'
import type { NpiStage } from '../../npi/domain'

const created = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
// Project scheduling and BOM baseline are owned by this application.
export const npiProjects = pgTable('npi_projects', {
  programId: uuid('program_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'restrict' }),
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
    .references(() => projects.id, { onDelete: 'cascade' }),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
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
    .references(() => projects.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
})
export const npiTrackingItems = pgTable(
  'npi_tracking_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
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
  programId: uuid('program_id').references(() => projects.id, {
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

export const npiIssues = pgTable(
  'npi_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => npiProjects.programId, { onDelete: 'restrict' }),
    number: text('number').notNull().unique(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    severity: varchar('severity', { length: 20 }).notNull().default('Medium'),
    state: varchar('state', { length: 30 }).notNull().default('Open'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    targetDate: date('target_date').notNull(),
    trackingItemId: uuid('tracking_item_id').references(
      () => npiTrackingItems.id,
    ),
    bomItemId: uuid('bom_item_id').references(() => npiBomItems.id),
    version: integer('version').notNull().default(1),
    createdAt: created(),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('npi_issue_project').on(t.programId),
    index('npi_issue_owner').on(t.ownerId),
  ],
)
export const npiIssueHistory = pgTable('npi_issue_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  issueId: uuid('issue_id')
    .notNull()
    .references(() => npiIssues.id),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  comments: text('comments').notNull(),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  timestamp: timestamp('timestamp', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
export const npiAttachments = pgTable(
  'npi_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => npiProjects.programId),
    trackingItemId: uuid('tracking_item_id').references(
      () => npiTrackingItems.id,
    ),
    issueId: uuid('issue_id').references(() => npiIssues.id),
    name: text('name').notNull(),
    title: text('title').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull(),
    fileHash: text('file_hash').notNull(),
    storageKey: text('storage_key').notNull().unique(),
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
    unique('npi_attachment_request').on(t.uploadedBy, t.requestId),
    index('npi_attachment_project').on(t.programId),
  ],
)
