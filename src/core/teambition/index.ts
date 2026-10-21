/**
 * Teambition vocabulary and wire helpers shared by both halves.
 *
 * The modules re-exported here are free of node and browser APIs (except
 * `endpoints.ts`, which only builds URL strings): they exist so the host half
 * and the tests import one stable surface.
 *
 * @module dsh-teambition/core/teambition
 */
export * from './types.ts'
export * from './endpoints.ts'
export * from './mapping.ts'
export * from './redact.ts'
