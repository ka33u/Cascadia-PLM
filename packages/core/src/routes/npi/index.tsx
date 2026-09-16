// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router'
import { NpiWorkspace } from '../../components/npi/NpiWorkspace'

export const Route = createFileRoute('/npi/')({ component: NpiWorkspace })
