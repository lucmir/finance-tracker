//
// Client-safe budget constants, shared by the server validation and the
// budgets page (routes never import server modules).

/** Largest monthly limit, in minor units: the integer column's upper bound. */
export const MAX_BUDGET_LIMIT_MINOR = 2_147_483_647;
