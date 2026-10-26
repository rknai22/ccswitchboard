// === GRACE START_BLOCK: broker_modules ========================================
// MODULE_CONTRACT:
//   OUT: the list of feature modules the broker loads, in call order.
//   INV: the core works with an empty list — topics, sessions, the pinned
//        limits message and the digest are all modules on top of it.

import type { BrokerModule } from './context.ts'

export const modules: BrokerModule[] = []
// === GRACE END_BLOCK: broker_modules ==========================================
