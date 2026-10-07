/** A Task-level necessity so a fake Manager plan passes the plan quality check. */
export const necessityFor = () => ({ serves: "test fixture", if_omitted: "test fixture" });

/** One light criterion carrying the whole free-text acceptance of a fake Manager plan. */
export const criteriaFor = (acceptance) => [{ id: "AC1", text: acceptance, check: "test fixture", serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", kind: "work_check" }];

/** Makes runManagerPlan of a fake runner add necessity and acceptance_criteria to every planned Task that has none; returns the same runner. */
export function withNecessity(runner) {
  const run = runner.runManagerPlan;
  if (typeof run !== "function") return runner;
  runner.runManagerPlan = async (...args) => {
    const result = await run.apply(runner, args);
    const tasks = result?.report?.tasks;
    if (!Array.isArray(tasks)) return result;
    return {
      ...result,
      report: {
        ...result.report,
        tasks: tasks.map((task) => ({
          ...task,
          necessity: task.necessity === undefined ? necessityFor() : task.necessity,
          acceptance_criteria: task.acceptance_criteria === undefined ? criteriaFor(task.acceptance) : task.acceptance_criteria,
        })),
      },
    };
  };
  return runner;
}
