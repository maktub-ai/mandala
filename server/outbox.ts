import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../shared/workspace-contracts";
export type OutboxInput = Pick<EventEnvelope, "type" | "aggregateId" | "aggregateRevision" | "causationId" | "payload">;
export function createOutbox(database: DatabaseSync) {
  return {
    enqueueOutbox(input: OutboxInput): number {
      database.prepare(`INSERT INTO outbox(id,type,aggregate_id,aggregate_revision,causation_id,schema_version,created_at,payload)
        VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(type,aggregate_id,aggregate_revision,causation_id) DO NOTHING`).run(
        randomUUID(), input.type, input.aggregateId, input.aggregateRevision, input.causationId,
        new Date().toISOString(), JSON.stringify(input.payload),
      );
      return Number(database.prepare("SELECT sequence FROM outbox WHERE type=? AND aggregate_id=? AND aggregate_revision=? AND causation_id=?")
        .get(input.type, input.aggregateId, input.aggregateRevision, input.causationId)!.sequence);
    },
    listOutbox(afterSequence: number): EventEnvelope[] {
      return database.prepare(`SELECT sequence,id,type,aggregate_id AS aggregateId,aggregate_revision AS aggregateRevision,
        causation_id AS causationId,schema_version AS schemaVersion,created_at AS createdAt,payload FROM outbox WHERE sequence>? ORDER BY sequence`)
        .all(afterSequence).map(row => ({ ...row, payload: JSON.parse(row.payload as string) })) as EventEnvelope[];
    },
  };
}
