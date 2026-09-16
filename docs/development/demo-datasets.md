# Demo Datasets

Three seedable demo datasets ship with Cascadia. All are static bundles fetched
from [`Cascadia-PLM/Demo-Data`](https://github.com/Cascadia-PLM/Demo-Data) and
replayed straight into the database — no CAD toolchain, no workers, no network.

One command seeds them all:

| Dataset          | `--only` key       | What you get                                                                                              |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| TDJ-25 robot arm | `robot-arm`        | `ROBOT-ARM` program, `TDJ-25` design, ~88 parts, ~101 BOM edges, ~79 GLB + thumbnail pairs, a release ECO |
| FreeCAD / KiCad  | `freecad`          | `PUC` and `USV` programs — the whole engineering record, see below                                        |
| Standard library | `standard-library` | Unreleased components in `STD-LIB`, each with a model — see below                                         |

```bash
npm run db:seed && npm run demo:fetch && npm run seed:demo
```

`db:seed` first: every dataset assumes the admin user, the roles and the shipped
lifecycles already exist, and none of them creates those. The standard-library
dataset additionally needs the library design itself, which `db:seed` creates.

Each dataset is independently idempotent — it checks for its own content and
does nothing if it is there — so re-running is safe, as is running when only
some of them were seeded before. A dataset that is missing from disk is
reported and skipped rather than fatal, so one absent bundle does not cost you
the ones you have; the exit code is still non-zero, so CI notices.

`npm run seed:demo -- --only robot-arm` (or `freecad`, or `standard-library`)
seeds just one.

## The FreeCAD / KiCad datasets

Two products, deliberately taken through different flows so the dataset
exercises both:

| Program | Design         | Product                                                                   |
| ------- | -------------- | ------------------------------------------------------------------------- |
| `PUC`   | `PUC-CART-24V` | 4WD skid-steer powered utility cart, 62+ items — post-release ECO flow    |
| `USV`   | `USV-CAT-3M`   | 3 m semi-autonomous survey catamaran, 45+ items — pre-release review flow |

Each carries the full engineering record, not just geometry: parts and
assemblies with BOM and AML, requirements and V&V with coverage gaps left in on
purpose, ECO history, KiCad boards with Software items and firmware, MES
travelers with work orders and serialized units with genealogy,
Cables-workbench harnesses, and TechDraw drawings.

The cart's last ECO adds a drop-in wall kit (`PUC-1800`), and it is the one that
**changes what the top-level assembly looks like**: stake pockets welded to the
bed plate and four panels dropped into them. Open `PUC-0000` and compare rev D
against rev C in the 3D viewer and the overlay is a walled box against a flat
deck. Every other ECO in the dataset revises a leaf part, which leaves nothing
to see at the top — so this is the one to demo the comparison view with.

## The standard-library dataset

Components for the **Standard Parts Library**, seeded unreleased — revision A,
Draft, in no BOM. The library is where a component sits while it is still a
candidate, and the demo needs that state to be visible. Two 24 V LiFePO4
batteries today (75 Ah and 20 Ah), the same family as the cart's `PUC-1510`
(50 Ah) at three genuinely different sizes.

**It is a third dataset rather than part of the FreeCAD bundle, and it has to
be.** That bundle is a database bake scoped to _programs_, and the Standard
Parts Library is global: `db:seed` creates it on every install with a fixed
design id but a `gen_random_uuid()` main branch and initial commit. Nothing
baked could reference those, and the bake refuses a program-less design outright
as a leaked row. So this dataset ships the way the robot arm does — a manifest
plus models — and its seeder resolves `STD-LIB` on the target before writing.

**It carries no item numbers.** A library part draws from the shared `Part`
sequence, the same one a user creating one by hand draws from, so a dataset
pinning `PN-000001` would collide with whatever an install already had. The
manifest keys parts by model name; the seeder allocates the number, advances the
sequence, and records the key in `items.attributes` so a re-run recognises its
own work rather than seeding duplicates.

Authored by the FreeCADDemo repository's `library/` build and converted by
Cascadia's own cad-converter, so the models carry the same up-axis rotation as
every other GLB in the demo — `demo:fetch` checks them for it.

## Where the FreeCAD bundle comes from

It is **baked**, not written. The dataset is authored by a separate ~10k-line
Python pipeline (the FreeCADDemo repository) that drives FreeCAD 1.1, KiCad 10
and the CAD-converter workers, pushing everything through Cascadia's HTTP API
over one to two hours. That is a good authoring pipeline and a hopeless seed: it
needs two CAD toolchains, Docker workers, a live server and an API key, and it
mints different UUIDs on every run.

So the pipeline runs once, a bake freezes the answer, and what ships is the
frozen result.

```
Python pipeline  ──►  a seeded database  ──►  bake  ──►  bundle  ──►  seed  ──►  any database
   (1-2 hours,                                                        (seconds,
    full toolchain)                                                    no toolchain)
```

### Seeding

The FreeCAD dataset's seeder walks the order it was given, so it needs no
schema knowledge of its own. Rows go in through
`json_populate_recordset(null::<table>, $1::json)`, which hands Postgres the
JSON and lets it parse each value into the column's own type — that is what
keeps timestamps, JSONB, arrays and enums working without the script carrying a
type table. Then it patches the deferred columns, advances the number sequences
so the next part a user creates does not collide with a baked item number, and
copies the blobs into the vault at storage paths regenerated from the new ids.

Idempotent: it skips entirely if a baked program already exists.

| Env               | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `DEMO_DATA_DIR`   | where the bundle lives (default `./demo-data`)        |
| `VAULT_ROOT`      | where blobs are copied (default `./vault`)            |
| `DEMO_SKIP_FILES` | `true` seeds rows only — no vault blobs, no 3D models |

## Ids are derived, not natural

A baked id is `sha256(namespace + source id)`, shaped as a v4 UUID. This needs
no per-table knowledge of what makes a row unique, and keeps every relationship
consistent for free, because one source id maps to one result wherever it
appears — including inside JSONB payloads and in text like a
`Part:design:<uuid>` sequence scope key, which no foreign key would have
declared.

The consequence worth knowing: re-baking a **fresh** pipeline run yields
different ids, because the source ids are themselves fresh. That is fine. The
guarantee that matters is that one bundle seeds to the same ids on every machine
and every run, and bundles are pinned by tag in `scripts/fetch-demo-data.ts`.
