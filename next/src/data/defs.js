// Stat resolution for every monster kind (IMPROVEMENTS F1.2): keepers, the KEEPERS creatures,
// then the Wave-1 kinds. data/enemies.js never imports this module or data/keepers.js, so
// there is no import cycle. New callers use defOf / ALL_DEFS; typeOf keeps its Wave-1 meaning.
import { ALL_TYPES, EXTRA_TYPES, typeOf } from "./enemies.js";
import { KEEPERS } from "./keepers.js";

const own = (table, kind) => (Object.hasOwn(table, kind) ? table[kind] : undefined);
// typeOf reads ALL_TYPES by plain lookup, so an inherited name ("toString") is screened here.
const inherited = (table, kind) => kind in table && !Object.hasOwn(table, kind);

export const defOf = (kind) => own(KEEPERS, kind) ?? own(EXTRA_TYPES, kind) ?? (inherited(ALL_TYPES, kind) ? null : typeOf(kind));
export const ALL_DEFS = Object.freeze({ ...ALL_TYPES, ...EXTRA_TYPES, ...KEEPERS });
