"""识别环线证据并生成有效站序。"""
from __future__ import annotations

from ...cmm import Route, TransitKind, normalize_transit_kind
from ...data import MapData, Transport
from ...line_topology import normalize_station_sequence
from ...transit import type_def


def effective_sequence(route_or_ids: Route | list[int] | tuple[int, ...]) -> tuple[int, ...]:
    ids = route_or_ids.stop_ids if isinstance(route_or_ids, Route) else tuple(route_or_ids)
    topology = normalize_station_sequence(ids)
    if topology.simple_sequence is not None:
        return tuple(topology.simple_sequence)
    return tuple(topology.sequence)


def has_stop_line_closure(mapdata: MapData, stop_node_ids, kind: TransitKind | str) -> bool:
    """Accept an explicit final-to-first stop-line, including two-stop shuttles."""
    if len(stop_node_ids) < 2:
        return False
    first, last = int(stop_node_ids[0]), int(stop_node_ids[-1])
    if mapdata.node(first) is None or mapdata.node(last) is None:
        return False
    if first == last:
        return True
    definition = type_def(normalize_transit_kind(kind).value)
    if definition is None or not definition.line_network:
        return False
    wanted = definition.line_network.casefold()
    return any(
        segment.start_node_id == last
        and segment.end_node_id == first
        and (segment.name or "").strip().casefold() == wanted
        for segment in mapdata.segments
    )


def is_loop_route(mapdata: MapData, transport: Transport,
                  kind: TransitKind | str | None = None) -> bool:
    stops = [item.node_id for item in transport.stops]
    return has_stop_line_closure(mapdata, stops, kind or transport.type)


def loop_evidence(mapdata: MapData, route: Route, kind: TransitKind | str) -> bool:
    return bool(route.is_closed or has_stop_line_closure(mapdata, route.stop_ids, kind))


class LoopEvidenceService:
    is_loop = staticmethod(is_loop_route)
    effective_sequence = staticmethod(effective_sequence)
