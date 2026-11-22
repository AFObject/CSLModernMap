import {cumulative, distance, planarDistance, pointAt} from './geometry';
import {itinerary} from './itinerary';
import {dwellSeconds, runningSeconds} from './time-planner';
import type {Edge, NavigationPackage, RouteResult} from './types';

export type LineInspection = {route: RouteResult; segmentLengths: number[]};

function follows(before: Edge, after: Edge): boolean {
  return before.toStopIndex === after.fromStopIndex && before.toNode === after.fromNode;
}

export function inspectLine(data: NonNullable<NavigationPackage['transit']>, lineId: string): LineInspection | null {
  const routes = new Map<string, Edge[]>();
  for (const edge of data.edges) {
    if (edge.mode !== 'RIDE' || edge.lineId !== lineId || !edge.routeId) continue;
    let route = routes.get(edge.routeId);
    if (!route) routes.set(edge.routeId, route = []);
    route.push(edge);
  }
  if (!routes.size) return null;

  const stationOwners = new Map<string, Set<string>>();
  for (const [id, station] of Object.entries(data.stationObjects ?? {})) {
    for (const platform of station.platforms) {
      const node = 'stop:' + platform;
      let owners = stationOwners.get(node);
      if (!owners) stationOwners.set(node, owners = new Set());
      owners.add(id);
    }
  }
  const reversesAt = (incoming: Edge, outgoing: Edge): boolean => {
    const a = incoming.fromNode, b = outgoing.toNode;
    if (a === b) return true;
    if ([...(stationOwners.get(a) ?? [])].some(owner => stationOwners.get(b)?.has(owner))) return true;
    const name = incoming.fromStop?.trim().toLowerCase();
    if (name && name === outgoing.toStop?.trim().toLowerCase() && distance(data.nodes[a], data.nodes[b]) < 200)
      return true;
    if (incoming.schematic || outgoing.schematic) return false;
    // An express return may skip the previous platform but still retrace the approach.
    const before = data.geometries[incoming.geometryRef], after = data.geometries[outgoing.geometryRef];
    const beforeOffsets = cumulative(before), afterOffsets = cumulative(after);
    const beforeLength = beforeOffsets.at(-1)!, afterLength = afterOffsets.at(-1)!;
    const probe = Math.min(80, beforeLength / 2, afterLength / 2);
    return probe >= 20 && [probe / 2, probe].every(offset => {
      const arrival = pointAt(before, beforeOffsets, incoming.reverse ? offset / beforeLength : 1 - offset / beforeLength);
      const departure = pointAt(after, afterOffsets, outgoing.reverse ? 1 - offset / afterLength : offset / afterLength);
      return planarDistance(arrival, departure) <= Math.min(15, offset / 3);
    });
  };
  const directions: Edge[][] = [];
  const splitDirections = (chain: Edge[]) => {
    const closed = follows(chain.at(-1)!, chain[0]);
    // CS1 can store both directions in one closed chain, with a reversal at each terminus.
    const turns = chain.flatMap((edge, index) =>
      (index > 0 || closed) && reversesAt(chain[index - 1] ?? chain.at(-1)!, edge) ? [index] : []);
    if (closed && turns.length) {
      turns.forEach((start, index) => {
        const end = turns[index + 1];
        directions.push(end === undefined ? [...chain.slice(start), ...chain.slice(0, turns[0])] : chain.slice(start, end));
      });
    } else {
      const boundaries = [0, ...turns, chain.length];
      boundaries.slice(1).forEach((end, index) => directions.push(chain.slice(boundaries[index], end)));
    }
  };
  for (const route of routes.values()) {
    route.sort((a, b) => a.fromStopIndex! - b.fromStopIndex!);
    let start = 0;
    for (let i = 1; i < route.length; i++) {
      if (follows(route[i - 1], route[i])) continue;
      splitDirections(route.slice(start, i));
      start = i;
    }
    splitDirections(route.slice(start));
  }
  const edges = directions.reduce((longest, direction) => direction.length > longest.length ? direction : longest);
  const traversals = edges.map(edge => ({edgeId: edge.id, fromFraction: 0, toFraction: 1}));
  const details = itinerary({edges, nodes: data.nodes}, traversals);
  const stops = details.legs[0].stopSequence!;
  let distanceM = 0, durationSeconds = 0;
  stops[0].elapsedSeconds = 0;
  edges.forEach((edge, index) => {
    distanceM += edge.lengthM;
    durationSeconds += runningSeconds(edge) + (index === 0 ? 0 : dwellSeconds(edges[index - 1]));
    stops[index + 1].elapsedSeconds = durationSeconds;
  });

  return {segmentLengths: edges.map(edge => edge.lengthM), route: {
    ...details, status: 'ok', costProfile: 'transit', distanceM, durationSeconds,
    durationModel: 'cs1-transit-time-v1', cost: durationSeconds, costUnit: 'seconds',
    roadNames: [], edgeIds: edges.map(edge => edge.id), traversals,
    quality: {}, warningCodes: [], maneuvers: [],
    geometry: edges.flatMap(edge => {
      const points = data.geometries[edge.geometryRef];
      return edge.reverse ? [...points].reverse() : points;
    }),
  }};
}
