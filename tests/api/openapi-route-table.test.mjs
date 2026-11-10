import assert from "node:assert/strict";
import { test } from "node:test";

import { listApiRoutes } from "../../apps/server/dist/http-routes.js";
import { loadOpenApi, openApiOperations } from "../helpers/openapi.mjs";

const key = ({ method, path }) => `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;
const duplicates = (items) => items.filter((item, index) => items.indexOf(item) !== index);

test("route table and OpenAPI list the same operations, with the same variable names", () => {
  const routes = listApiRoutes();
  const operations = openApiOperations(loadOpenApi());
  const routePaths = new Map(routes.map((route) => [key(route), route.path]));
  const operationPaths = new Map(operations.map((operation) => [key(operation), operation.path]));

  const onlyInRoutes = [...routePaths.keys()].filter((k) => !operationPaths.has(k));
  const onlyInOpenApi = [...operationPaths.keys()].filter((k) => !routePaths.has(k));
  assert.deepEqual({ onlyInRoutes, onlyInOpenApi }, { onlyInRoutes: [], onlyInOpenApi: [] });

  const renamed = [...routePaths].filter(([k, path]) => operationPaths.get(k) !== path)
    .map(([k, path]) => `${k}: route ${path} / openapi ${operationPaths.get(k)}`);
  assert.deepEqual(renamed, []);

  assert.deepEqual(duplicates(routes.map(key)), [], "duplicate route keys");
  assert.deepEqual(duplicates(operations.map(key)), [], "duplicate OpenAPI keys");
});
