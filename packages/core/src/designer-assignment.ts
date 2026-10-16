export type AssignedDesigner = "designer" | "lead_designer";

/** A new Task: a plan item, a replan addition or a replacement. */
export function designerStateAtCreation(
  type: string,
  assigned: AssignedDesigner | null | undefined,
  designMode: "auto" | "lead",
): { assigned_designer: AssignedDesigner | null; lead_designer_start_round: number | null } {
  if (type !== "design") return { assigned_designer: null, lead_designer_start_round: null };
  const assignedDesigner = assigned ?? null;
  return {
    assigned_designer: assignedDesigner,
    lead_designer_start_round: designMode === "lead" || assignedDesigner === "lead_designer" ? 0 : null,
  };
}

/**
 * A retried Task after its revision is applied. null keeps the state row 20 left
 * (same design type and no new designation).
 */
export function designerStateAfterRetry(
  before: { type: string; assigned_designer: AssignedDesigner | null; design_escalated: number },
  after: { type: string; assigned_designer?: AssignedDesigner | null },
  designMode: "auto" | "lead",
): { assigned_designer: AssignedDesigner | null; lead_designer_start_round: number | null; design_escalated: number } | null {
  // Not a design Task now: clear every design-only state, so a later replacement does not inherit a stale escalation.
  if (after.type !== "design") return { assigned_designer: null, lead_designer_start_round: null, design_escalated: 0 };
  // Became a design Task: decide like a new Task (the Work's design_mode applies when unspecified).
  if (before.type !== "design") return { ...designerStateAtCreation("design", after.assigned_designer, designMode), design_escalated: 0 };
  // Same design type, no new designation: keep the current state.
  if (after.assigned_designer == null) return null;
  // Same design type, new designation: the Owner's choice and Core's escalation still win.
  const lead = after.assigned_designer === "lead_designer" || designMode === "lead" || before.design_escalated === 1;
  return { assigned_designer: after.assigned_designer, lead_designer_start_round: lead ? 0 : null, design_escalated: before.design_escalated };
}
