// === GRACE START_BLOCK: broker_modules ========================================
// MODULE_CONTRACT:
//   OUT: the list of feature modules the broker loads, in call order.
//   INV: the core works with an empty list — topics, sessions, the pinned
//        limits message and the digest are all modules on top of it.

import type { BrokerModule } from './context.ts'
import { digestModule } from './digest.ts'
import { pinModule } from './pin.ts'
import { sessionsModule } from './sessions.ts'
import { topicsModule } from './topics.ts'

// topics first: it handles the forum service messages before anyone else.
export const modules: BrokerModule[] = [topicsModule, sessionsModule, pinModule, digestModule]
// === GRACE END_BLOCK: broker_modules ==========================================
