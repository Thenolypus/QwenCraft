import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import { repoRoot } from "./config";
import type { Observation } from "./types";

const ajv = new Ajv({ allErrors: true });

const observationSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), "schemas", "observation.schema.json"), "utf8")
) as object;

const validateObservationSchema = ajv.compile<Observation>(observationSchema);

export function validateObservation(value: unknown): Observation {
  if (!validateObservationSchema(value)) {
    throw new Error(`observation schema validation failed: ${ajv.errorsText(validateObservationSchema.errors)}`);
  }
  return value;
}
