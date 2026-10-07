// For tests whose subject is not the plan quality gate: turn the gate off so a
// minimal fixture plan (no necessity entries) is accepted and the path under
// test runs. Call after core.start(), on the same db the Core uses.
export async function disablePlanQuality(db) {
  await db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      "INSERT OR REPLACE INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('plan_quality', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ enabled: false }), now,
    );
  });
}
