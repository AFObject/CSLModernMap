import maplibregl from 'maplibre-gl';
import type {ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapMouseEvent} from 'maplibre-gl';
import {i18n} from '../i18n';
import {controlIcon, setButtonContent, type ControlIcon} from '../control-icons';
import {RoutingClient} from './client';
import {cumulative, geo, slice} from './geometry';
import {RoutingError} from './types';
import {completedRouteColor, missingRouteTrafficColor, trafficColor} from '../traffic-paint';
import {NavigationSimulation} from './simulation';
import type {Preview3D} from '../preview-3d';
import {renderRouteFeatures, routeStrokeFeatures, type RouteStroke} from './route-stroke';
import {arrowOutlineWidth, turnArrowFeatures} from './turn-arrows';
import type {Edge, Endpoint, NavigationPackage, RouteResult, RoutingProfile, TransitLeg, TransitStop, XYZ} from './types';
import {searchGroups, type Candidate, type SearchFeature} from '../preview-search';
import {pointAt} from './geometry';
import {WALK_SECONDS_PER_METER} from './time-planner';
import {inspectLine, type LineInspection} from './line-inspection';
import {spaceMixedText} from '../text-spacing';
import {scaledTransitWidth} from '../transit-scale';

import type {TransitCandidate} from './types';
import './ui.css';

const currentRouteColor: ExpressionSpecification = ['case',
  ['boolean', ['feature-state', 'completed'], false], completedRouteColor,
  ['interpolate', ['linear'], ['get', 'trafficBlend'],
    0, trafficColor(['get', 'congestion'], missingRouteTrafficColor),
    1, trafficColor(['get', 'trafficNeighbor'], missingRouteTrafficColor)]];
// 混入浅底色而不是降低透明度，重叠的分段不会因此加深。
const alternativeRouteColor: ExpressionSpecification = ['interpolate', ['linear'], .55,
  0, '#E5E9EE', 1, currentRouteColor];

const text = (key: string, values: Record<string, number | string> = {}): string =>
  spaceMixedText(i18n.t(`navigation_${key}`, values));
const actionIcons: Record<string, ControlIcon> = {
  title: 'route', close: 'x', drivingMode: 'car', transit: 'bus', start: 'map-pin', end: 'flag',
  swap: 'arrows-up-down', cancel: 'x', retry: 'refresh', useCoordinate: 'check', fit: 'zoom-scan',
  clearRoute: 'trash', timelineBack: 'arrow-back-up',
};
const lineIds = ['navigation-casing', 'navigation-road', 'navigation-access', 'navigation-building', 'navigation-building-outline', 'navigation-transit', 'navigation-walk', 'navigation-schematic', 'navigation-stops', 'navigation-turn-fill', 'navigation-turn-outline', 'navigation-alternative-casing', 'navigation-alternative-road'];
const profiles: RoutingProfile[] = ['car-balanced', 'car-shortest'];
const LONG_TRANSFER_METERS = 800;
const profileLabel = (profile: RoutingProfile) => text(profile === 'transit' ? 'transit' : profile === 'car-balanced' ? 'balanced' : 'shortest');
const distanceLabel = (meters: number) => meters >= 1000 ? `${(meters/1000).toFixed(2)} km` : `${Math.round(meters)} m`;
const durationLabel = (seconds: number): string => {
  if (seconds === 0) return text('durationZero');
  if (seconds < 60) return text('durationUnderMinute');
  const minutes = Math.ceil(seconds/60);
  return minutes < 60 ? text('durationMinutes', {minutes})
    : text('durationHours', {hours: Math.floor(minutes/60), minutes: minutes%60});
};

export type NavigationRoadStyle = {
  properties: (edge: Edge) => Record<string, unknown>;
  width: (casing: boolean) => ExpressionSpecification;
  widthMeters: (edge: Edge) => number;
};

export type PlaceInspection = {
  name: string; kind: string; district?: string; position: XYZ; geometry: GeoJSON.Geometry;
  lines?: {id: number; name: string; color: string; kind: string}[];
};

export function lineCapsule(name: string, color = '#526071'): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'navigation-line-capsule';
  badge.textContent = spaceMixedText(name);
  badge.style.backgroundColor = color;
  badge.style.color = name.trim().toLowerCase() === 'central line' ? '#17202a' : '#fff';
  return badge;
}

const minuteLabel = (seconds: number) => spaceMixedText(
  new Intl.NumberFormat(i18n.language, {style:'unit',unit:'minute',unitDisplay:'long'}).format(Math.round(seconds/60)));
const timelineMinutes = (seconds: number) => text('timelineMinutes', {minutes: Math.round(seconds/60)});
function walkingIcon(): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<circle cx="14" cy="4" r="2" fill="currentColor"/><path d="m7 13 2-4 4-2 3 5 4 1m-7-5-2 7 4 6m-4-7-4 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return icon;
}
function walkCapsule(meters:number): HTMLElement {
  const chip=document.createElement('span');chip.className='navigation-walk-capsule';
  const time = minuteLabel(meters * WALK_SECONDS_PER_METER);
  chip.setAttribute('aria-label', text('walk')+' '+time);
  chip.append(walkingIcon(), time);
  return chip;
}
export class NavigationControl {
  readonly simulation: NavigationSimulation;
  private routeStrokes: GeoJSON.Feature[] = [];
  private routeFeatures: GeoJSON.Feature[] = [];
  private renderZoom = -1;
  private progressMeters: number | null = null;
  private completedStrokes = 0;
  private routeArrows: GeoJSON.Feature[] = [];
  private completedArrows = 0;
  private readonly root = document.createElement('section');
  private readonly panel = document.createElement('div');
  private panelOpened: () => void = () => {};
  onRouteFocus: (active:boolean)=>void = ()=>{};
  onNavigationOpened: () => void = () => {};
  private immersive = false;
  private readonly message = document.createElement('div');
  private readonly summary = document.createElement('div');
  private readonly steps = document.createElement('ol');
  private readonly coordinates = document.createElement('input');
  private readonly modes = document.createElement('div');
  private profile: RoutingProfile = 'car-balanced';
  private readonly routes = new Map<RoutingProfile, RouteResult>();
  private transitRoutes: TransitCandidate[] = [];
  private selectedCandidateId: string | null = null;

  private readonly routeErrors = new Map<RoutingProfile, string>();
  private busy = false;
  private readonly routeDetails = document.createElement('details');
  private readonly coordinateDetails = document.createElement('details');
  private readonly resultActions = document.createElement('div');
  private readonly cancelButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly startButton: HTMLElement;
  private readonly endButton: HTMLElement;
  private readonly placeInputs = {origin: document.createElement('input'), destination: document.createElement('input')};
  private readonly placeResults = document.createElement('div');
  private readonly morePlaces: HTMLButtonElement;
  private placeLimit = 8;
  private searchCandidates: Candidate[] = [];
  private placeMatches: Candidate[] = [];
  private focusedPlace = -1;
  private composing = false;
  private locatePlace: (feature: SearchFeature) => void = () => {};
  private readonly transitDetails = document.createElement('section');
  private readonly stationDetails = document.createElement('section');
  private readonly transitSteps = document.createElement('ol');
  private readonly transitSummary = document.createElement('h2');
  private readonly backButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private detailsOpen = false;
  private inspectedPlace: PlaceInspection | null = null;
  private placeMarker: maplibregl.Marker | null = null;
  private inspectedLine: LineInspection | null = null;
  private lineRequest = 0;
  private listScroll = 0;
  private selectedLeg: number | null = null;
  private origin: Endpoint | null = null;
  private destination: Endpoint | null = null;
  private get result(): RouteResult | null {
    if (this.inspectedLine) return this.inspectedLine.route;
    return this.profile === 'transit'
      ? this.transitRoutes.find(route => route.candidateId === this.selectedCandidateId) ?? null
      : this.routes.get(this.profile) ?? null;
  }
  private client: RoutingClient | null = null;
  private loading: Promise<RoutingClient> | null = null;
  private loader: (() => Promise<NavigationPackage>) | null = null;
  private epoch = 0;
  private operation = 0;
  private picking: 'origin' | 'destination' | null = null;
  private marks: maplibregl.Marker[] = [];
  private routeStopLabels: maplibregl.Marker[] = [];
  private popup: maplibregl.Popup | null = null;
  private routePopup: maplibregl.Popup | null = null;
  private routeCard: HTMLElement | null = null;
  private longPress = 0;
  private previewTimer = 0;
  private readonly languageChanged = () => this.translate();
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (this.simulation.active) this.simulation.stop();
    else if ((this.detailsOpen || this.inspectedLine) && !this.panel.hidden) this.showTransitDetails(false);
    else if (this.inspectedPlace) this.closeInspection();
    else if (!this.immersive || this.picking || this.busy || this.popup?.isOpen()) this.cancel();
    else if (!this.panel.hidden) {
      this.hidePanel(); this.root.querySelector('button')?.focus();
    } else return;
    if (this.immersive) event.preventDefault();
  };

  constructor(private readonly map: MapLibreMap,
    private readonly selectionActive: () => boolean,
    private readonly planningStarted: () => void,
    private readonly placeAt: (point: {x: number; y: number}) => Endpoint['place'],
    private readonly roadStyle: NavigationRoadStyle, private readonly preview3d: Preview3D) {
    this.root.className = 'navigation-control'; this.root.hidden = true;
    const toggle = this.button('title', () => {
      if (this.simulation.active) { this.simulation.stop(); return; }
      if (this.inspectedLine || this.inspectedPlace) { this.closeInspection(); return; }
      this.panel.hidden = !this.panel.hidden; this.popup?.remove();
      if (!this.panel.hidden) { this.panelOpened(); this.onNavigationOpened(); }
      if (this.panel.hidden) this.cancel(); else { this.planningStarted(); this.activateMissingEndpoint(); }
    });
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(!this.panel.hidden)));
    this.panel.className = 'navigation-panel'; this.panel.hidden = true;
    const heading = document.createElement('div'); heading.className = 'navigation-heading';
    const title = document.createElement('h2'); title.dataset.navigationKey = 'title';
    this.closeButton = this.button('close', () => {
      if (this.inspectedLine || this.inspectedPlace) this.closeInspection(); else this.hidePanel(true);
      toggle.focus();
    });
    this.closeButton.classList.add('navigation-close');
    this.closeButton.dataset.navigationLabel = 'close';
    this.backButton = this.button('timelineBack', () => this.showTransitDetails(false));
    this.backButton.classList.add('navigation-close');
    this.backButton.dataset.navigationLabel = 'timelineBack';
    this.fitButton = this.button('fit', () => this.fitRoute());
    this.fitButton.classList.add('navigation-fit'); this.fitButton.dataset.navigationLabel = 'fit';
    this.transitSummary.className = 'navigation-transit-summary';
    const headingActions = document.createElement('div');
    headingActions.className = 'navigation-heading-actions';
    headingActions.append(this.fitButton, this.backButton, this.closeButton);
    heading.append(title, this.transitSummary, headingActions);
    this.modes.className = 'navigation-modes';
    for (const mode of ['drivingMode', 'transit'] as const) {
      const button = this.button(mode, () => void this.setMode(mode === 'transit'));
      button.dataset.mode = mode; this.modes.append(button);
    }
    const endpointButtons = document.createElement('div'); endpointButtons.className = 'navigation-endpoints';
    this.startButton = this.endpointInput('origin');
    this.endButton = this.endpointInput('destination');
    const swap = this.button('swap', () => void this.rematchEndpoints(this.profile, [this.destination, this.origin]));
    swap.dataset.navigationLabel = 'swap'; swap.classList.add('navigation-swap');
    endpointButtons.append(this.startButton, this.endButton, swap);
    this.cancelButton = this.button('cancel', () => this.cancel()); this.cancelButton.hidden = true;
    this.retryButton = this.button('retry', () => { this.cancel(); void this.query(); }); this.retryButton.hidden = true;
    this.coordinates.type = 'text'; this.coordinates.setAttribute('aria-label', text('coordinate'));
    const form = document.createElement('form'); form.className = 'navigation-actions';
    const submit = this.button('useCoordinate', () => {}); submit.type = 'submit';
    form.append(this.coordinates, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const parts = this.coordinates.value.trim().split(/[,，\s]+/), values = parts.map(Number);
      if (parts.length !== 2 || parts.some(part => !part) || !values.every(Number.isFinite)) { this.message.textContent = text('INVALID_ENDPOINT'); return; }
      if (!this.picking) this.picking = this.origin ? 'destination' : 'origin';
      void this.choose([values[0], 0, values[1]]);
    });
    const coordinateTitle = document.createElement('summary');
    coordinateTitle.dataset.navigationKey = 'coordinateSelection'; this.coordinateDetails.append(coordinateTitle, form);
    this.coordinateDetails.hidden = true;
    this.message.setAttribute('role', 'status'); this.message.setAttribute('aria-live', 'polite');
    this.message.className = 'navigation-status';
    this.placeResults.id = 'navigation-place-results'; this.placeResults.className = 'navigation-place-results';
    this.placeResults.setAttribute('role', 'listbox'); this.placeResults.hidden = true;
    this.morePlaces = this.button('morePlaces', () => {
      if (!this.picking) return;
      const key = this.picking, previous = this.placeLimit;
      this.searchPlaces(key, previous+8); this.focusedPlace = previous; this.markPlaceFocus(key);
      this.placeInputs[key].focus();
    });
    this.morePlaces.className = 'navigation-more-places'; this.morePlaces.hidden = true;
    this.summary.className = 'navigation-routes'; this.summary.setAttribute('aria-label', text('driving'));
    const stepsTitle = document.createElement('summary'); stepsTitle.dataset.navigationKey = 'routeDetails';
    this.routeDetails.className = 'navigation-steps'; this.routeDetails.append(stepsTitle, this.steps); this.routeDetails.hidden = true;
    this.transitDetails.className = 'navigation-transit-details'; this.transitDetails.hidden = true;
    this.transitDetails.tabIndex = -1;
    this.transitSteps.className = 'navigation-itinerary';
    this.transitDetails.append(this.transitSteps);
    this.stationDetails.className = 'navigation-station-lines'; this.stationDetails.hidden = true;
    this.resultActions.className = 'navigation-actions'; this.resultActions.hidden = true;
    this.simulation = new NavigationSimulation(map, this.root, meters => this.drawProgress(meters), preview3d);
    this.resultActions.append(this.simulation.startButton);
    const statusActions = document.createElement('div'); statusActions.className = 'navigation-actions';
    statusActions.append(this.cancelButton, this.retryButton);
    const clear = this.button('clearRoute', () => this.clearRoute()); clear.className = 'navigation-clear';
    this.panel.append(heading, endpointButtons, this.modes, this.placeResults, this.morePlaces, this.coordinateDetails, this.message, statusActions,
      this.summary, this.transitDetails, this.stationDetails, this.resultActions, this.routeDetails, clear);
    for (const name of ['click', 'dblclick', 'pointerdown', 'touchstart'] as const)
      this.panel.addEventListener(name, event => event.stopPropagation());
    this.root.append(toggle, this.panel); document.body.append(this.root);
    this.root.prepend(toggle);
    this.translate(); i18n.on('languageChanged', this.languageChanged);
    window.addEventListener('keydown', this.keydown);
    map.on('contextmenu', event => { if (!this.selectionActive() && this.loader) { event.preventDefault(); this.menu(event.lngLat); } });
    map.on('touchstart', event => {
      if (event.points.length !== 1 || this.selectionActive() || !this.loader) return;
      this.longPress = window.setTimeout(() => this.menu(event.lngLat), 650);
    });
    for (const name of ['touchmove', 'touchend', 'dragstart'] as const)
      map.on(name, () => window.clearTimeout(this.longPress));
    map.on('zoomend', () => {
      const source = map.getSource('navigation') as GeoJSONSource | undefined;
      if (source && this.routeFeatures.length && this.renderZoom !== Math.floor(map.getZoom()))
        source.setData(this.renderCollection());
    });
  }

  private button(key: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.navigationKey = key;
    if (actionIcons[key]) setButtonContent(button, text(key), actionIcons[key]); else button.textContent = text(key);
    button.addEventListener('click', action); return button;
  }

  private endpointInput(key: 'origin' | 'destination'): HTMLElement {
    const row = document.createElement('div'); row.className = 'navigation-endpoint';
    const label = document.createElement('label'); label.className = 'navigation-endpoint-label';
    label.dataset.navigationLabel = key; label.htmlFor = `navigation-${key}`;
    label.append(controlIcon(key === 'origin' ? 'map-pin' : 'flag'));
    const input = this.placeInputs[key]; input.id = label.htmlFor; input.type = 'text'; input.autocomplete = 'off'; input.className = 'navigation-endpoint-name';
    input.dataset.navigationLabel = key;
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'navigation-place-results'); input.setAttribute('aria-expanded', 'false');
    input.addEventListener('focus', () => { if (this.picking !== key) this.begin(key); input.select(); });
    input.addEventListener('pointerdown', () => { if (this.picking !== key) this.begin(key); });
    row.addEventListener('click', event => {
      if (event.target !== input) input.focus();
    });
    input.addEventListener('compositionstart', () => { this.composing = true; });
    input.addEventListener('compositionend', () => { this.composing = false; this.searchPlaces(key); });
    input.addEventListener('input', () => {
      this.operation++; this.client?.cancel(); this.busy = false; this.picking = key;
      this.selectedLeg = null; this.detailsOpen = false; this.updateDetailView();
      this.cancelButton.hidden = false; this.retryButton.hidden = true; this.coordinateDetails.hidden = false;
      this.startButton.setAttribute('aria-pressed', String(key === 'origin')); this.endButton.setAttribute('aria-pressed', String(key === 'destination'));
      this.map.getCanvas().style.cursor = 'crosshair';
      this.renderCards();
      this.searchPlaces(key);
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing || this.composing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.focusedPlace >= 0) this.submitPlace(this.placeMatches[this.focusedPlace]);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (this.placeResults.hidden) this.searchPlaces(key);
        if (!this.placeMatches.length) return;
        this.focusedPlace = this.focusedPlace < 0 ? event.key === 'ArrowDown' ? 0 : this.placeMatches.length-1
          : (this.focusedPlace+(event.key === 'ArrowDown' ? 1 : -1)+this.placeMatches.length)%this.placeMatches.length;
        this.markPlaceFocus(key);
      }
    });
    row.append(label, input); return row;
  }

  setSearchCandidates(candidates: Candidate[], locate: (feature: SearchFeature) => void): void {
    this.searchCandidates = candidates; this.locatePlace = locate;
    if (this.picking && document.activeElement === this.placeInputs[this.picking]) this.searchPlaces(this.picking);
  }

  private closePlaces(): void {
    this.placeMatches = []; this.focusedPlace = -1; this.placeResults.replaceChildren(); this.placeResults.hidden = true;
    this.morePlaces.hidden = true;
    for (const input of Object.values(this.placeInputs)) {
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    }
  }

  private searchPlaces(key: 'origin' | 'destination', limit = 8): void {
    const query = this.placeInputs[key].value;
    this.closePlaces();
    if (!query.trim()) { this.message.textContent = text(key === 'origin' ? 'pickOrigin' : 'pickDestination'); return; }
    const matches = searchGroups(this.searchCandidates, query).flatMap(group => group.items);
    this.placeLimit = limit; this.placeMatches = matches.slice(0, limit); this.morePlaces.hidden = matches.length <= limit;
    this.placeResults.hidden = !this.placeMatches.length;
    this.placeInputs[key].setAttribute('aria-expanded', String(!this.placeResults.hidden));
    this.message.textContent = text(this.placeMatches.length ? key === 'origin' ? 'pickOrigin' : 'pickDestination' : 'noPlaces');
    this.placeMatches.forEach((candidate, index) => {
      const option = document.createElement('div'); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      option.id = `navigation-place-${index}`;
      option.setAttribute('aria-posinset', String(index+1)); option.setAttribute('aria-setsize', String(matches.length));
      const props = candidate.feature.properties;
      const kind = props.geometryRole === 'station' || props.sourceKind === 'stop' || props.stationId
        ? text('station') : i18n.t(`search_group_${candidate.kind}`);
      option.textContent = spaceMixedText(`${candidate.name} · ${candidate.categoryName || kind}${candidate.context ? ` · ${candidate.context}` : ''}`);
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => this.submitPlace(candidate)); this.placeResults.append(option);
    });
  }

  private markPlaceFocus(key: 'origin' | 'destination'): void {
    [...this.placeResults.children].forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === this.focusedPlace));
      if (index === this.focusedPlace) {
        this.placeInputs[key].setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({block: 'nearest'});
      }
    });
  }

  private submitPlace(candidate: Candidate): void {
    const feature = candidate.feature, geometry = feature.geometry;
    let anchor = feature.properties.navigationAnchor as number[] | undefined;
    let context = candidate.kind === 'road' ? 'roadReference' : candidate.kind === 'building' ? 'buildingReference' : 'areaReference';
    if (geometry.type === 'Point') { anchor = geometry.coordinates; context = ''; }
    else if (!anchor && geometry.type === 'LineString') {
      const points = geometry.coordinates.map(p => [p[1]*111195, 0, -p[0]*111195] as XYZ);
      anchor = geo(pointAt(points, cumulative(points), .5)); context = 'roadReference';
    }
    this.operation++; this.client?.cancel(); this.closePlaces();
    if (!anchor) { this.locatePlace(feature); this.message.textContent = text('mapPointRequired'); return; }
    void this.choose([anchor[1]*111195, 0, -anchor[0]*111195], {name: candidate.name, geometry,
      key: candidate.key, kind: candidate.kind, context: context || undefined});
  }

  private activateMissingEndpoint(): void {
    if (!this.origin) this.begin('origin'); else if (!this.destination) this.begin('destination');
  }

  mount(container: HTMLElement, opened: () => void): void {
    container.append(this.root); this.panelOpened = opened;
  }

  hidePanel(exitNavigation = false): void {
    if (this.inspectedLine || this.inspectedPlace) this.closeInspection();
    this.panel.hidden = true;
    if (exitNavigation) this.clearRoute();
    else this.cancel();
    this.root.querySelector('button')?.setAttribute('aria-expanded', 'false');
  }

  get selectingPoint(): boolean { return this.picking !== null; }
  get transitFocus(): boolean { return this.result?.costProfile === 'transit'; }
  get guidingRoute(): boolean { return this.result !== null && this.inspectedLine === null; }
  get canInspectTransitLines(): boolean {
    return this.loader !== null && this.panel.hidden && !this.result;
  }
  get canInspectPlaces(): boolean {
    return this.canPickTransitLine || this.inspectedLine !== null;
  }
  get canPickTransitLine(): boolean {
    return this.canInspectTransitLines || (this.inspectedPlace !== null && this.inspectedLine === null);
  }
  setImmersive(immersive: boolean): void { this.immersive = immersive; }

  openPlace(place: PlaceInspection): void {
    if (!this.canInspectPlaces) return;
    const switchingFromLine = this.inspectedLine !== null;
    this.cancel();
    this.inspectedLine = null;
    this.inspectedPlace = place;
    this.updatePlaceMarker();
    this.panelOpened();
    this.panel.hidden = false;
    this.root.querySelector('button')?.setAttribute('aria-expanded', 'true');
    if (switchingFromLine) this.draw();
    this.displayResult();
  }

  async openTransitLine(id: string): Promise<void> {
    const canOpen = () => this.canInspectTransitLines || (!this.inspectedLine
      && this.inspectedPlace?.lines?.some(line => String(line.id) === id));
    if (!canOpen()) return;
    const request = ++this.lineRequest, operation = this.operation;
    try {
      const {data} = await this.ensureClient();
      if (request !== this.lineRequest || operation !== this.operation || !canOpen() || !data.transit) return;
      const inspection = inspectLine(data.transit, id);
      if (!inspection) return;
      this.cancel();
      this.inspectedLine = inspection;
      this.updatePlaceMarker();
      this.panelOpened();
      this.panel.hidden = false;
      this.root.querySelector('button')?.setAttribute('aria-expanded', 'true');
      this.draw();
      this.displayResult();
      this.transitSteps.scrollTop = 0;
      this.fitRoute();
    } catch (error) {
      if (request === this.lineRequest && operation === this.operation) this.fail(error, operation);
    }
  }

  dismissMapSelection(): void {
    if (this.inspectedPlace || this.inspectedLine) this.closeInspection();
  }

  private closeInspection(returnToStation = false): void {
    this.lineRequest++;
    this.inspectedLine = null;
    if (!returnToStation) this.inspectedPlace = null;
    this.updatePlaceMarker();
    this.panel.hidden = this.inspectedPlace === null;
    this.root.querySelector('button')?.setAttribute('aria-expanded', String(!this.panel.hidden));
    this.draw();
    this.displayResult();
    if (this.panel.hidden) this.message.textContent = text('ready');
  }

  private translate(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-navigation-key]')) {
      const key = element.dataset.navigationKey!;
      if (element instanceof HTMLButtonElement && actionIcons[key]) setButtonContent(element, text(key), actionIcons[key]);
      else element.textContent = text(key);
    }
    this.root.setAttribute('aria-label', text('title'));
    const toggle = this.root.querySelector('button')!;
    toggle.title = text('title');
    toggle.setAttribute('aria-label', text('title'));
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-navigation-label]')) element.setAttribute('aria-label', text(element.dataset.navigationLabel!));
    this.fitButton.title = text('fit');
    this.backButton.title = text('timelineBack');
    this.closeButton.title = text('close');
    this.coordinates.placeholder = text('coordinate'); this.coordinates.setAttribute('aria-label', text('coordinate'));
    this.renderEndpoints(); this.renderCards(); this.displayResult();
    if (!this.result && !this.inspectedPlace) this.message.textContent = text(this.busy ? 'computing' : this.picking === 'origin' ? 'pickOrigin' : this.picking ? 'pickDestination' : 'ready');
    if (this.picking && document.activeElement === this.placeInputs[this.picking] && !this.composing) this.searchPlaces(this.picking);
  }

  private transferArrow(): HTMLSpanElement {
    const arrow = document.createElement('span');
    arrow.className = 'navigation-transfer-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '▸';
    return arrow;
  }

  setScene(loader: (() => Promise<NavigationPackage>) | null, routeOmitted = false): void {
    this.loader = loader; this.root.hidden = loader === null;
    if (routeOmitted) { this.panel.hidden = false; this.root.querySelector('button')?.setAttribute('aria-expanded', 'true'); this.message.textContent = text('outsideRoute'); this.planningStarted(); }
  }

  async restoreRoute(value: Record<string, unknown>): Promise<void> {
    const operation = ++this.operation;
    try {
      const client = await this.ensureClient();
      if (operation !== this.operation || value.snapshotId !== client.data.snapshotId
          || value.graphRevision !== client.data.graphRevision || value.costRevision !== client.data.costRevision) return;
      const origin = value.origin as Endpoint, destination = value.destination as Endpoint;
      if (!origin?.snap || !destination?.snap || !Array.isArray(origin.position) || !Array.isArray(destination.position)) return;
      this.profile = value.costProfile === 'transit' && client.data.transit ? 'transit'
        : value.costProfile === 'car-balanced' && client.data.costModel?.id === 'car-balanced-v1' ? 'car-balanced' : 'car-shortest';
      this.origin = origin; this.destination = destination;
      this.panel.hidden = false; this.root.querySelector('button')?.setAttribute('aria-expanded', 'true'); await this.query();
    } catch (error) { this.fail(error, operation); }
  }

  clear(): void {
    this.inspectedLine = null;
    this.inspectedPlace = null;
    this.updatePlaceMarker();
    this.panel.hidden = true; this.clearRoute(); this.client?.stop(); this.client = null; this.loading = null; this.loader = null; this.epoch++;
    this.searchCandidates = [];
    this.root.hidden = true; this.panel.hidden = true;
    this.root.querySelector('button')?.setAttribute('aria-expanded', 'false');
    this.profile = 'car-balanced';
    this.displayResult();
    for (const details of [this.coordinateDetails, this.routeDetails]) details.open = false;
    for (const id of lineIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource('navigation')) this.map.removeSource('navigation');
  }

  dispose(): void {
    this.clear(); this.simulation.dispose(); this.root.remove(); i18n.off('languageChanged', this.languageChanged);
    window.removeEventListener('keydown', this.keydown); window.clearTimeout(this.longPress);
    window.clearTimeout(this.previewTimer);
  }

  private clearRoute(): void {
    this.cancel(); this.origin = this.destination = null; this.resetResults(); this.draw();
    if (!this.panel.hidden) this.activateMissingEndpoint();
  }

  private cancel(): void {
    this.operation++; this.client?.cancel(); this.picking = null; this.busy = false;
    this.coordinateDetails.hidden = true;
    this.cancelButton.hidden = true; this.retryButton.hidden = !this.origin || !this.destination || this.result !== null;
    this.startButton.setAttribute('aria-pressed', 'false'); this.endButton.setAttribute('aria-pressed', 'false');
    this.closePlaces(); this.popup?.remove();
    window.clearTimeout(this.previewTimer);
    for (const marker of this.marks) {
      const value = marker.getElement().classList.contains('origin') ? this.origin : this.destination;
      if (value) marker.setLngLat(geo(value.position));
    }
    this.map.getCanvas().style.cursor = ''; this.renderEndpoints(); this.renderCards(); this.displayResult();
    if (!this.result) this.message.textContent = text('ready');
  }

  private begin(endpoint: 'origin' | 'destination'): void {
    this.simulation.stop();
    this.panelOpened();
    this.cancel(); this.panel.hidden = false; this.picking = endpoint;
    this.routePopup?.remove();
    this.selectedLeg = null; this.detailsOpen = false; this.updateDetailView();
    this.planningStarted();
    this.root.querySelector('button')?.setAttribute('aria-expanded', 'true');
    this.startButton.setAttribute('aria-pressed', String(endpoint === 'origin'));
    this.endButton.setAttribute('aria-pressed', String(endpoint === 'destination'));
    this.message.textContent = text(endpoint === 'origin' ? 'pickOrigin' : 'pickDestination'); this.map.getCanvas().style.cursor = 'crosshair';
    this.cancelButton.hidden = false; this.retryButton.hidden = true;
    this.coordinateDetails.hidden = false;
  }

  handleClick(event: MapMouseEvent): boolean {
    if (this.selectionActive()) return false;
    if (this.picking) {
      void this.choose([event.lngLat.lat*111195, 0, -event.lngLat.lng*111195], this.placeAt(event.point)); return true;
    }
    if (!this.result || this.result.costProfile === 'transit' || this.simulation.active) return false;
    const layers = [lineIds[0], lineIds[1], lineIds[11], lineIds[12]];
    const hit = this.map.queryRenderedFeatures([
      [event.point.x-5, event.point.y-5], [event.point.x+5, event.point.y+5],
    ], {layers}).find(feature => feature.properties.routeProfile);
    if (!hit) return false;
    this.selectDrivingProfile(hit.properties.routeProfile as RoutingProfile);
    return true;
  }

  private selectDrivingProfile(profile: RoutingProfile): void {
    if (this.profile === profile) return;
    this.simulation.stop(); this.popup?.remove();
    this.profile = profile; this.selectedLeg = null;
    this.renderCards(); this.draw(); this.displayResult();
  }

  private menu(location: maplibregl.LngLat): void {
    this.popup?.remove();
    const content = document.createElement('div'); content.className = 'navigation-actions';
    for (const endpoint of ['origin', 'destination'] as const) content.append(this.button(endpoint === 'origin' ? 'start' : 'end', () => {
      this.begin(endpoint); void this.choose([location.lat*111195, 0, -location.lng*111195], this.placeAt(this.map.project(location)));
    }));
    content.append(this.button('close', () => this.popup?.remove()));
    this.popup = new maplibregl.Popup({closeButton: false}).setLngLat(location).setDOMContent(content).addTo(this.map);
  }

  private async ensureClient(): Promise<RoutingClient> {
    if (this.client) return this.client;
    if (!this.loader) throw new RoutingError('DATA_INCOMPLETE');
    const epoch = this.epoch, loader = this.loader;
    if (!this.loading) this.loading = loader().then(data => {
      if (epoch !== this.epoch) throw new RoutingError('CANCELLED');
      if (this.profile === 'car-balanced' && data.costModel?.id !== 'car-balanced-v1') this.profile = 'car-shortest';
      this.client = new RoutingClient(data, epoch); return this.client;
    }).finally(() => { if (epoch === this.epoch) this.loading = null; });
    return this.loading;
  }

  private activeProfiles(): RoutingProfile[] {
    return this.profile === 'transit' ? ['transit'] : profiles;
  }

  private async setMode(transit: boolean): Promise<void> {
    if (transit === (this.profile === 'transit')) return;
    await this.rematchEndpoints(transit ? 'transit' : 'car-balanced', [this.origin, this.destination]);
  }

  private async rematchEndpoints(profile: RoutingProfile, endpoints: (Endpoint | null)[]): Promise<void> {
    this.cancel(); const operation = ++this.operation;
    this.resetResults(); this.draw();
    try {
      const client = await this.ensureClient();
      if (operation !== this.operation) return;
      if (profile === 'car-balanced' && client.data.costModel?.id !== 'car-balanced-v1') profile = 'car-shortest';
      const snapped: (Endpoint | null)[] = [];
      for (const endpoint of endpoints) {
        snapped.push(endpoint ? {...endpoint, snap: (await client.snap(endpoint.position, profile))[0]} : null);
        if (operation !== this.operation) return;
      }
      this.profile = profile;
      [this.origin, this.destination] = snapped;
      this.renderEndpoints(); this.draw();
      if (this.origin && this.destination) await this.query(); else this.activateMissingEndpoint();
    } catch (error) {
      if (operation !== this.operation) return;
      this.renderEndpoints(); this.draw(); this.fail(error, operation);
    }
  }

  private fail(error: unknown, operation: number): void {
    if (operation !== this.operation || (error instanceof RoutingError && error.code === 'CANCELLED')) return;
    this.busy = false; this.cancelButton.hidden = !this.picking;
    this.retryButton.hidden = !this.origin || !this.destination || this.result !== null;
    this.renderCards();
    this.message.textContent = text(error instanceof RoutingError ? error.code : 'WORKER_FAILED');
  }

  private async choose(position: XYZ, place?: Endpoint['place']): Promise<void> {
    const endpoint = this.picking ?? (this.origin ? 'destination' : 'origin');
    this.client?.cancel(); const operation = ++this.operation;
    this.closePlaces(); this.message.textContent = text('preparing'); this.cancelButton.hidden = false;
    try {
      const client = await this.ensureClient();
      if (operation !== this.operation) return;
      const snaps = await client.snap(position, this.profile);
      if (operation !== this.operation) return;
      this[endpoint] = {position, snap: snaps[0], place};
      this.placeInputs[endpoint].blur();
      this.cancel(); this.resetResults(); this.coordinateDetails.open = false; this.draw();
      if (!this.origin || !this.destination) this.activateMissingEndpoint(); else void this.query();
    } catch (error) { this.fail(error, operation); }
  }

  private async query(): Promise<void> {
    if (!this.origin || !this.destination) return;
    this.planningStarted();
    const origin = this.origin.snap, destination = this.destination.snap;
    const operation = ++this.operation;
    this.resetResults(); this.busy = true; this.cancelButton.hidden = false;
    this.draw(); this.renderCards(); this.message.textContent = text('computing');
    try {
      const client = await this.ensureClient();
      if (operation !== this.operation) return;
      const results = new Map<RoutingProfile, RouteResult>(), errors = new Map<RoutingProfile, string>();
      let transit: TransitCandidate[] = [];
      // 候选整组作为一次 Worker 请求；驾车两个 profile 继续顺序查询。
      for (const profile of this.activeProfiles()) {
        if (profile === 'car-balanced' && client.data.costModel?.id !== 'car-balanced-v1') continue;
        try {
          if (profile === 'transit') transit = await client.candidates(origin, destination);
          else results.set(profile, await client.route(origin, destination, profile));
        }
        catch (error) {
          if (operation !== this.operation) return;
          if (!(error instanceof RoutingError) || error.code !== 'NO_PATH') throw error;
          errors.set(profile, error.code);
        }
        if (operation !== this.operation) return;
      }
      this.routes.clear(); this.routeErrors.clear();
      for (const [profile, result] of results) this.routes.set(profile, result);
      for (const [profile, error] of errors) this.routeErrors.set(profile, error);
      this.busy = false; this.cancelButton.hidden = true;
      this.transitRoutes = transit; this.selectedCandidateId = transit[0]?.candidateId ?? null;
      this.retryButton.hidden = this.result !== null;
      this.renderCards(); this.draw(); this.displayResult();
      if (!this.result) this.message.textContent = text(this.routeErrors.get(this.profile) ?? 'NO_PATH');
      if (this.profile !== 'transit' && this.routes.size) this.fitGeometry([...this.routes.values()].flatMap(route => route.geometry));
    } catch (error) { this.fail(error, operation); }
  }

  private resetResults(): void {
    this.detailsOpen = false; this.selectedLeg = null;
    this.transitRoutes = []; this.selectedCandidateId = null;
    this.routes.clear(); this.routeErrors.clear(); this.busy = false;
    this.clearRouteStopLabels();
    this.onRouteFocus(false);
    this.retryButton.hidden = true; this.routeDetails.open = false;
    this.renderEndpoints(); this.renderCards(); this.displayResult();
  }

  private renderEndpoints(): void {
    for (const [key, button] of [['origin', this.startButton], ['destination', this.endButton]] as const) {
      const endpoint = this[key];
      const name = endpoint ? endpoint.place?.name || endpoint.snap.name || text('unnamed') : '';
      const input = this.placeInputs[key]; input.placeholder = text('placePlaceholder');
      if (this.picking !== key || document.activeElement !== input) input.value = name;
      button.setAttribute('aria-pressed', String(this.picking === key));
    }
  }

  private renderCards(): void {
    this.routeCard = null; this.routePopup?.remove();
    this.summary.setAttribute('aria-label', text(this.profile === 'transit' ? 'transit' : 'driving'));
    for (const button of this.modes.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-pressed', String((button.dataset.mode === 'transit') === (this.profile === 'transit')));
    this.summary.replaceChildren();
    if (this.profile === 'transit' && !this.busy && !this.transitRoutes.length) return;
    if (!this.busy && !this.routes.size && !this.transitRoutes.length && !this.routeErrors.size) return;
    if (this.profile !== 'transit') {
      const heading = document.createElement('p'); heading.className = 'navigation-section-title'; heading.textContent = text('driving');
      this.summary.append(heading);
    }
    const entries: Array<{profile: RoutingProfile; result?: RouteResult; candidate?: TransitCandidate}> = this.profile === 'transit'
      ? this.transitRoutes.length
        ? this.transitRoutes.map(candidate => ({profile: 'transit', result: candidate, candidate}))
        : [{profile: 'transit'}]
      : this.activeProfiles().map(profile => ({profile, result: this.routes.get(profile)}));
    for (const {profile, result, candidate} of entries) {
      if (profile === 'car-balanced' && this.client && this.client.data.costModel?.id !== 'car-balanced-v1') continue;
      const card = document.createElement('button'); card.type = 'button';
      card.className = profile === 'transit' ? 'navigation-route-card' : 'navigation-route-option';
      card.classList.toggle('transit', profile === 'transit');
      card.dataset.profile = profile;
      if (candidate) card.dataset.candidateId = candidate.candidateId;
      card.setAttribute('aria-pressed', String(candidate ? candidate.candidateId === this.selectedCandidateId : profile === this.profile));
      card.disabled = !result || this.busy;
      const label = document.createElement('span'); label.className = 'navigation-route-label'; label.textContent = profileLabel(profile);
      label.prepend(controlIcon(profile === 'transit' ? 'bus' : 'car'));
      const duration = document.createElement('span'); duration.className = 'navigation-duration';
      duration.textContent = this.busy ? text('computing') : result && profile !== 'transit'
        ? durationLabel(result.durationSeconds!) : text(this.routeErrors.get(profile) ?? 'NO_PATH');
      if(result && profile==='transit') duration.textContent=minuteLabel(result.durationSeconds!);
      duration.classList.toggle('has-estimate', result?.durationSeconds != null);
      card.append(label, duration);
      if (result) {
        const distance = document.createElement('span'); distance.className = 'navigation-distance';
        distance.textContent = profile==='transit'
          ? `${(result.distanceM/1000).toFixed(2)} km · ${Math.max(0,result.boardings!-1)} ${text('transfers')} · ${text('walk')} ${Math.round(result.walkingDistanceM!)} m`
          : distanceLabel(result.distanceM);
        const roads = profile === 'transit' ? result.legs?.filter(leg => leg.mode === 'ride').map(leg => leg.name || text('transit')) ?? [] : result.roadNames;
        const via = document.createElement('span'); via.className = 'navigation-via';
        via.textContent = roads.length ? spaceMixedText(`${text('via')} ${roads.slice(0, 2).join(' · ')}${roads.length > 2 ? '…' : ''}`) : text(profile === 'transit' ? 'walkingOnly' : 'unnamed');
        card.append(distance, via);
        if (profile === 'transit') {
          label.hidden = true; via.replaceChildren();
          for (const [index, leg] of (result.legs ?? []).entries()) {
            if (index) via.append(this.transferArrow());
            via.append(leg.mode === 'ride' ? lineCapsule(leg.name || text('transit'), leg.color) : walkCapsule(leg.walkKind==='transfer' ? Math.max(100,leg.distanceM) : leg.distanceM));
          }
          const long = result.legs?.find(leg => leg.walkKind === 'transfer' && leg.distanceM > LONG_TRANSFER_METERS);
          if (long) {
            const notice = document.createElement('span'); notice.className = 'navigation-transfer-notice';
            notice.textContent = `${text('longTransfer')} ${distanceLabel(long.distanceM)}`; card.append(notice);
          }
          if (candidate && this.transitRoutes.length > 1) {
            const advantages = document.createElement('span'); advantages.className = 'navigation-route-advantages';
            for (const [key, metric] of [
              ['walkingLess', (route: TransitCandidate) => route.walkingDistanceM!],
              ['transfersLess', (route: TransitCandidate) => Math.max(0, route.boardings!-1)],
            ] as const) if (this.transitRoutes.every(other => other === candidate || metric(candidate) < metric(other))) {
              const badge = document.createElement('span'); badge.textContent = text(key); advantages.append(badge);
            }
            card.append(advantages);
          }
        }
      }
      if (profile !== 'transit' && result && !this.busy) {
        card.classList.add('navigation-route-card');
        if (profile === this.profile) {
          this.routeCard = document.createElement('div');
          this.routeCard.className = 'navigation-map-card';
          this.routeCard.dataset.routeProfile = profile;
          this.routeCard.setAttribute('aria-label', text('routeDetails'));
          this.routeCard.append(label.cloneNode(true), duration.cloneNode(true));
        }
      }
      card.addEventListener('click', () => {
        if (candidate) {
          this.selectTransitCandidate(candidate.candidateId);
          this.summary.querySelector<HTMLButtonElement>(`.navigation-route-card[data-candidate-id="${candidate.candidateId}"]`)?.focus({preventScroll: true});
          return;
        }
        this.selectDrivingProfile(profile);
        this.summary.querySelector<HTMLButtonElement>(`[data-profile="${profile}"]`)?.focus();
      });
      this.summary.append(card);
      if (profile === 'transit' && result) {
        const details = this.button('routeDetails', () => {
          this.selectTransitCandidate(candidate!.candidateId); this.showTransitDetails(true);
        });
        details.dataset.candidateId = candidate!.candidateId;
        details.setAttribute('aria-label', `${text('routeDetails')} · ${duration.textContent} · ${result.legs!.filter(leg => leg.mode === 'ride').map(leg => leg.name).join(' → ') || text('walkingOnly')}`);
        details.className = 'navigation-open-details';
        details.title = text('routeDetails');
        const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
        icon.setAttribute('viewBox','0 0 24 24'); icon.setAttribute('aria-hidden','true');
        icon.innerHTML = '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
        details.replaceChildren(icon);
        const row = document.createElement('div'); row.className = 'navigation-choice';
        card.replaceWith(row); row.append(card,details);
      }
    }
    this.updateRoutePopup();
    this.updateDetailView();
  }

  private updateRoutePopup(progress: number | null = this.progressMeters): void {
    if (!this.routeCard || !this.result || this.picking || progress !== null) {
      this.routePopup?.remove(); return;
    }
    this.routePopup ??= new maplibregl.Popup({closeButton: false, closeOnClick: false,
      focusAfterOpen: false, anchor: 'bottom', offset: 14, maxWidth: '240px', className: 'navigation-route-popup'});
    const points = this.result.geometry;
    this.routePopup.setLngLat(geo(pointAt(points, cumulative(points), .5)))
      .setDOMContent(this.routeCard).addTo(this.map);
  }

  private selectTransitCandidate(id: string): void {
    if (this.picking) this.cancel();
    if (this.selectedCandidateId === id) return;
    this.simulation.stop(); this.selectedCandidateId = id; this.selectedLeg = null;
    this.renderCards(); this.draw(); this.displayResult();
  }

  private updateDetailView(): void {
    this.transitDetails.hidden = !this.inspectedLine && (!this.detailsOpen || this.profile !== 'transit' || !this.result);
    this.stationDetails.hidden = !this.inspectedPlace || Boolean(this.inspectedLine);
    const showingDetails = !this.transitDetails.hidden || !this.stationDetails.hidden;
    this.summary.hidden = showingDetails;
    this.transitSummary.hidden = !showingDetails;
    this.backButton.hidden = this.transitDetails.hidden || Boolean(this.inspectedLine && !this.inspectedPlace);
    this.closeButton.hidden = !this.backButton.hidden;
    this.fitButton.hidden = !this.result;
    this.panel.classList.toggle('navigation-details-open', showingDetails);
    this.panel.classList.toggle('navigation-station-open', !this.stationDetails.hidden);
  }

  private showTransitDetails(open: boolean): void {
    if (!open && this.inspectedLine) {
      this.closeInspection(true);
      return;
    }
    this.detailsOpen = open;
    if (open) this.listScroll = this.panel.scrollTop;
    this.updateDetailView();
    if (open) { this.panel.scrollTop = 0; this.backButton.focus({preventScroll: true}); }
    else {
      this.panel.scrollTop = this.listScroll;
      this.summary.querySelector<HTMLButtonElement>(`.navigation-open-details[data-candidate-id="${this.selectedCandidateId}"]`)?.focus({preventScroll: true});
    }
  }

  private fitRoute(): void {
    if (!this.result) return;
    this.fitGeometry(this.result.geometry);
  }

  private fitGeometry(points: XYZ[]): void {
    this.preview3d.reset(false);
    const bounds = new maplibregl.LngLatBounds(); points.forEach(p => bounds.extend(geo(p)));
    const panel = this.panel.getBoundingClientRect(), canvas = this.map.getCanvas(), narrow = window.innerWidth <= 520;
    this.map.fitBounds(bounds, {padding: {top: narrow ? 90 : 40, right: 40,
      left: narrow ? 40 : Math.min(panel.right+24, canvas.clientWidth*.45),
      bottom: narrow ? Math.min(panel.height+40, canvas.clientHeight*.65) : 40},
      maxZoom: 18, bearing: this.map.getBearing(), pitch: 0, duration: 300});
  }

  private displayResult(): void {
    this.steps.replaceChildren();
    this.transitSteps.replaceChildren();
    this.resultActions.hidden = this.routeDetails.hidden = !this.result;
    const result = this.result;
    this.routeDetails.hidden = !result || result.costProfile === 'transit';
    this.updateDetailView();
    this.simulation.setRoute(result);
    if (!this.stationDetails.hidden && this.inspectedPlace) {
      this.message.replaceChildren();
      this.renderPlaceDetails(this.inspectedPlace);
      return;
    }
    if (result) {
      const missing = ['SPEED_LIMIT_MISSING', 'TRAFFIC_MISSING', 'PREFAB_SPEED_LIMIT'].find(code => result.warningCodes.includes(code));
      this.message.textContent = missing ? text(missing) : '';
      if (result.costProfile === 'transit') {
        this.message.replaceChildren();
      }
    }
    if (result?.legs) {
      this.renderTransitItinerary(result);
      return;
    }
    for (const step of result?.maneuvers ?? []) {
      const item = document.createElement('li'); item.textContent = step.kind === 'arrive' ? text('arrive') : `${text(step.kind)} ${step.roadName || text('unnamed')} · ${Math.round(step.distanceM)} m`;
      this.steps.append(item);
    }
  }

  private updatePlaceMarker(): void {
    this.placeMarker?.remove();
    this.placeMarker = null;
    const place = this.inspectedPlace;
    if (!place || this.inspectedLine) return;
    const element = document.createElement('div');
    element.className = 'navigation-selected-place';
    element.setAttribute('aria-hidden', 'true');
    const pin = document.createElement('span');
    pin.className = 'navigation-selected-place-pin';
    pin.append(controlIcon(place.lines ? 'train' : place.geometry.type === 'Point' ? 'map-pin' : 'building'));
    element.append(pin);
    this.placeMarker = new maplibregl.Marker({element, anchor: 'bottom', rotationAlignment: 'viewport'})
      .setLngLat(geo(place.position)).addTo(this.map);
  }

  private renderPlaceDetails(place: PlaceInspection): void {
    const name = document.createElement('span');
    name.className = 'navigation-station-title'; name.textContent = spaceMixedText(place.name);
    const subtitle = document.createElement('span');
    subtitle.className = 'navigation-station-district';
    subtitle.textContent = spaceMixedText([place.kind, place.district].filter(Boolean).join(' · '));
    this.transitSummary.replaceChildren(name, subtitle);
    const actions = document.createElement('div');
    actions.className = 'navigation-place-actions';
    for (const [endpoint, icon, key] of [['origin', 'map-pin', 'timelineDepart'], ['destination', 'flag', 'timelineArrive']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      setButtonContent(button, text(key), icon);
      button.addEventListener('click', () => {
        this.origin = this.destination = null;
        this.closeInspection();
        if (place.lines) this.profile = 'transit';
        this.begin(endpoint);
        void this.choose(place.position, {name: place.name, geometry: place.geometry, kind: place.lines ? 'station' : 'building'});
      });
      actions.append(button);
    }
    this.stationDetails.replaceChildren(actions);
    for (const kind of ['metro', 'monorail', 'train', 'bus'] as const) {
      const lines = place.lines?.filter(line => line.kind === kind) ?? [];
      if (!lines.length) continue;
      const label = document.createElement('h3');
      label.className = 'navigation-station-mode'; label.textContent = text(`placeMode_${kind}`);
      const list = document.createElement('div');
      list.className = 'navigation-station-line-group';
      for (const line of lines) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'navigation-station-line';
        button.append(lineCapsule(line.name || `#${line.id}`, line.color));
        button.addEventListener('click', () => void this.openTransitLine(String(line.id)));
        list.append(button);
      }
      this.stationDetails.append(label, list);
    }
  }

  private renderTransitItinerary(result: RouteResult): void {
    const legs = result.legs!;
    const totalTime = document.createElement('span');
    totalTime.className = 'navigation-transit-total';
    if (result.durationSeconds != null) totalTime.textContent = timelineMinutes(result.durationSeconds);
    const subtitle = document.createElement('span');
    subtitle.className = 'navigation-transit-subtitle';
    subtitle.textContent = [
      `${(result.distanceM/1000).toFixed(2)} km`,
      `${Math.max(0, (result.boardings ?? 0)-1)} ${text('transfers')}`,
      `${text('walk')} ${Math.round(result.walkingDistanceM ?? 0)} m`,
      ].join(' · ');
    this.transitSummary.replaceChildren(totalTime, subtitle);

    const endpointName = (key: 'origin' | 'destination', station?: string) => {
      const endpoint = this[key];
      return endpoint?.place?.name || (endpoint?.snap.mode === 'ACCESS' && station) || endpoint?.snap.name || text(key);
    };
    const rides = legs.filter(leg => leg.mode === 'ride');
    const start = endpointName('origin', rides[0]?.fromStop);
    const end = endpointName('destination', rides.at(-1)?.toStop);
    const neutral = 'var(--nav-border)';
    const connector = (color?: string) => color ? `color-mix(in srgb, ${color} 12%, ${neutral})` : neutral;
    const timelineRow = (kind: string, before: string, after: string) => {
      const row = document.createElement('div');
      row.className = 'navigation-timeline-row ' + kind;
      row.style.setProperty('--track-before', before);
      row.style.setProperty('--track-after', after);
      const rail = document.createElement('span');
      rail.className = 'navigation-timeline-rail';
      rail.setAttribute('aria-hidden', 'true');
      const marker = document.createElement('span');
      marker.className = 'navigation-timeline-marker';
      if (kind === 'walk') marker.append(walkingIcon());
      rail.append(marker);
      const content = document.createElement('div');
      content.className = 'navigation-event-content';
      row.append(rail, content);
      return {row, content};
    };

    if (this.inspectedLine) {
      const leg = rides[0], stops = leg.stopSequence!, distances = this.inspectedLine.segmentLengths;
      const color = leg.color || 'var(--nav-secondary)';
      const name = lineCapsule(leg.name || text('transit'), leg.color);
      name.classList.add('navigation-inspected-name');
      subtitle.textContent = [text('lineStopCount', {count: stops.length}), distanceLabel(result.distanceM),
        timelineMinutes(result.durationSeconds!)].join(' · ');
      this.transitSummary.replaceChildren(name, subtitle);
      for (const [index, stop] of stops.entries()) {
        const first = index === 0, last = index === stops.length - 1;
        const kind = first ? 'boarding' : last ? 'alighting' : 'via-stop';
        const {row, content} = timelineRow('ride-stop line-stop ' + kind,
          first ? 'transparent' : color, last ? 'transparent' : color);
        row.style.setProperty('--stop-color', color);
        const title = document.createElement('div'), info = document.createElement('div');
        title.className = 'navigation-event-title';
        title.textContent = stop.name.trim() ? spaceMixedText(stop.name) : text('unnamedStop');
        title.title = title.textContent;
        info.className = 'navigation-event-info';
        info.textContent = timelineMinutes(stop.elapsedSeconds!);
        content.append(title, info);
        const item = document.createElement('li');
        item.append(row);
        if (!last) {
          const segment = document.createElement('div');
          segment.className = 'navigation-line-distance';
          segment.style.setProperty('--segment-color', color);
          segment.textContent = `${Math.round(distances[index])} m`;
          item.append(segment);
        }
        this.transitSteps.append(item);
      }
      return;
    }

    const event = (kind: string, before: string, after: string, heading: string, description: string) => {
      const item = document.createElement('li');
      const {row, content} = timelineRow(kind, before, after);
      const title = document.createElement('div'), info = document.createElement('div');
      title.className = 'navigation-event-title'; title.textContent = spaceMixedText(heading);
      info.className = 'navigation-event-info'; info.textContent = spaceMixedText(description);
      content.append(title, info);
      item.append(row);
      this.transitSteps.append(item);
    };

    const metersLabel = (meters: number) => text('timelineMeters', {meters: Math.round(meters)});
    const stationName = (name?: string) => name ? spaceMixedText(name) : text('unnamedStop');
    const data = this.client!.data.transit!;
    const edges = new Map(data.edges.map(edge => [edge.id, edge]));
    event('endpoint', 'transparent', neutral, text('timelineDepart'), start);

    for (const [index, leg] of legs.entries()) {
      const previous = legs[index-1], next = legs[index+1];
      if (leg.mode === 'walk') {
        if (leg.walkKind === 'transfer' && next?.transfer) continue;
        const destination = leg.toStopRef?.name ||
          (leg.walkKind === 'access' && rides[0] ? stationName(rides[0].fromStop) : end);
        event('walk', connector(previous?.color), connector(next?.color),
          text('timelineWalkTo', {place: destination}), text('timelineWalkDuration', {
            distance: metersLabel(leg.distanceM), time: timelineMinutes(leg.distanceM * WALK_SECONDS_PER_METER),
          }));
        continue;
      }

      const lineName = leg.name || text('transit');
      const color = leg.color || 'var(--nav-secondary)';
      const before = previous || leg.transfer ? connector(leg.color) : neutral;
      const after = next ? connector(leg.color) : neutral;
      if (leg.transfer) {
        const transfer = leg.transfer;
        const time = timelineMinutes(transfer.durationSeconds);
        const description = transfer.sameStation ? text('timelineInsideTransfer', {time})
          : text('timelineOutsideTransfer', {place: stationName(leg.fromStop),
            distance: metersLabel(transfer.walkingDistanceM), time});
        const incoming = previous?.mode === 'walk' ? legs[index-2] : previous;
        event('walk', connector(incoming?.color), before, text('timelineTransferLine', {line: lineName}), description);
      }

      const item = document.createElement('li');
      item.style.setProperty('--stop-color', color);
      const boarding = timelineRow('ride-stop boarding', before, color);
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'navigation-segment navigation-event-title';
      select.append(lineCapsule(lineName, leg.color), stationName(leg.fromStop));
      select.setAttribute('aria-pressed', String(this.selectedLeg === index));
      select.addEventListener('click', () => {
        this.selectedLeg = index;
        this.transitSteps.querySelectorAll('button.navigation-segment').forEach(button =>
          button.setAttribute('aria-pressed', String(button === select)));
        const points = result.traversals.slice(leg.traversalStart, leg.traversalEnd).flatMap(part => {
          const edge = edges.get(part.edgeId)!;
          const geometry = data.geometries[edge.geometryRef];
          return slice(geometry, cumulative(geometry), edge.reverse ? 1-part.fromFraction : part.fromFraction,
            edge.reverse ? 1-part.toFraction : part.toFraction);
        });
        if (points.length) this.fitGeometry(points);
      });
      boarding.content.append(select);
      item.append(boarding.row);

      const stops = leg.stopSequence ?? [];
      const intermediate = stops.slice(1, -1);
      const description = text('timelineRideDuration', {stops: leg.stops,
        time: timelineMinutes(stops.at(-1)?.elapsedSeconds ?? 0)});
      if (intermediate.length) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'navigation-event-info navigation-stops-toggle';
        toggle.textContent = description;
        const sequence = document.createElement('ol');
        sequence.className = 'navigation-timeline-stops';
        sequence.id = `navigation-stops-list-${index}`;
        sequence.hidden = true;
        toggle.setAttribute('aria-controls', sequence.id);
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          sequence.hidden = !sequence.hidden;
          toggle.setAttribute('aria-expanded', String(!sequence.hidden));
        });
        boarding.content.append(toggle);
        for (const stop of intermediate) {
          const stopItem = document.createElement('li');
          const passing = timelineRow('via-stop', color, color);
          const name = document.createElement('span'), time = document.createElement('span');
          name.textContent = stationName(stop.name);
          time.className = 'navigation-event-info';
          time.textContent = timelineMinutes(stop.elapsedSeconds ?? 0);
          passing.content.append(name, time);
          stopItem.append(passing.row);
          sequence.append(stopItem);
        }
        item.append(sequence);
      } else {
        const duration = document.createElement('div');
        duration.className = 'navigation-event-info';
        duration.textContent = description;
        boarding.content.append(duration);
      }

      const alighting = timelineRow('ride-stop alighting', color, after);
      const title = document.createElement('div');
      title.className = 'navigation-event-title';
      title.textContent = stationName(leg.toStop);
      alighting.content.append(title);
      item.append(alighting.row);
      this.transitSteps.append(item);
    }
    event('endpoint arrival', neutral, 'transparent', text('timelineArrive'), end);
  }

  private renderCollection(features = this.routeFeatures): GeoJSON.FeatureCollection {
    this.routeFeatures = features;
    this.renderZoom = Math.floor(this.map.getZoom());
    return {type: 'FeatureCollection', features: renderRouteFeatures(features, this.renderZoom)};
  }

  private clearRouteStopLabels(): void {
    for (const marker of this.routeStopLabels) marker.remove();
    this.routeStopLabels = [];
  }

  private drawTransitStops(legs: TransitLeg[]): GeoJSON.Feature[] {
    type RouteStop = {stop: TransitStop; endpoint: boolean; color: string; hiddenLabel?: boolean;
      transfer?: [TransitLeg, TransitLeg]; transferName?: string};
    const points = new Map<string, RouteStop>();
    let previousRide: TransitLeg | undefined;
    for (const leg of legs) {
      const stops = leg.stopSequence;
      if (leg.mode !== 'ride' || !stops?.length) continue;
      for (const [index, stop] of stops.entries()) {
        const endpoint = index === 0 || index === stops.length - 1;
        const previous = points.get(stop.stopId);
        if (previous) {
          previous.endpoint ||= endpoint;
        } else {
          points.set(stop.stopId, {stop, endpoint, color: leg.color ?? '#526071'});
        }
      }
      const arriving = previousRide?.stopSequence?.at(-1);
      const departing = stops[0];
      if (previousRide && arriving && leg.transfer?.sameStation) {
        const anchor = points.get(arriving.stopId)!;
        anchor.transfer = [previousRide, leg];
        anchor.transferName = arriving.name.trim() || departing.name.trim();
        if (arriving.stopId !== departing.stopId) points.get(departing.stopId)!.hiddenLabel = true;
      }
      previousRide = leg;
    }

    const features: GeoJSON.Feature[] = [];
    for (const point of points.values()) {
      const center = geo(point.stop.position);
      features.push({type: 'Feature', properties: {mode: 'STOP', color: point.color, endpoint: point.endpoint},
        geometry: {type: 'Point', coordinates: center}});
      const name = point.transferName || point.stop.name.trim();
      if (!point.transfer && (point.hiddenLabel || !name)) continue;
      const element = document.createElement('div'); element.className = 'navigation-route-stop-label';
      element.classList.toggle('is-endpoint', point.endpoint);
      const title = document.createElement('span');
      title.className = 'navigation-route-stop-name';
      title.textContent = spaceMixedText(name || text('unnamedStop'));
      element.append(title);
      if (point.transfer) {
        const lines = document.createElement('div');
        lines.className = 'navigation-route-stop-transfer';
        const [from, to] = point.transfer;
        lines.append(lineCapsule(from.name || text('transit'), from.color), this.transferArrow(),
          lineCapsule(to.name || text('transit'), to.color));
        element.append(lines);
      }
      this.routeStopLabels.push(new maplibregl.Marker({element, anchor: 'left', offset: [9, 0], rotationAlignment: 'viewport'})
        .setLngLat(center).addTo(this.map));
    }
    return features;
  }

  private draw(): void {
    for (const marker of this.marks) marker.remove(); this.marks = [];
    this.clearRouteStopLabels();
    this.onRouteFocus(Boolean(this.result));
    const features: GeoJSON.Feature[] = [];
    this.routeStrokes = [];
    this.routeArrows = [];
    if (this.result && this.client) {
      const transit = this.result.costProfile === 'transit';
      const data = transit ? this.client.data.transit! : this.client.data;
      const byId = new Map(data.edges.map(edge => [edge.id, edge]));
      const alternatives = transit ? [] : [...this.routes.values()].filter(route =>
        route !== this.result && JSON.stringify(route.traversals) !== JSON.stringify(this.result!.traversals));
      for (const route of [...alternatives, this.result]) {
        const alternative = route !== this.result;
        const strokes: RouteStroke[] = [];
        for (const traversal of route.traversals) {
          const edge = byId.get(traversal.edgeId)!, points = data.geometries[edge.geometryRef];
          if (edge.stationObject) continue;
          const from = edge.reverse ? 1-traversal.fromFraction : traversal.fromFraction;
          const to = edge.reverse ? 1-traversal.toFraction : traversal.toFraction;
          strokes.push({properties: {...this.roadStyle.properties(edge), alternative, routeProfile: route.costProfile,
            mode: edge.mode, color: edge.color, lineId: edge.lineId,
            schematic: edge.schematic ?? false, congestion: edge.congestion ?? -1},
            points: slice(points, cumulative(points), from, to)});
        }
        const roadFeatures = routeStrokeFeatures(strokes, !alternative && !transit ? 2 : Infinity)
          .map((feature, id) => ({...feature, id: alternative ? `alternative:${id}` : id}));
        features.push(...roadFeatures);
        if (!alternative && !transit) this.routeStrokes = roadFeatures;
      }
      if (this.result.legs) features.push(...this.drawTransitStops(this.result.legs));
      this.routeArrows = turnArrowFeatures(this.client.data, this.result, this.roadStyle.widthMeters);
      features.push(...this.routeArrows);
    }
    for (const endpoint of this.inspectedLine ? [] : ['origin', 'destination'] as const) {
      const value = this[endpoint]; if (!value) continue;
      if (value.place) features.push({type: 'Feature', properties: {mode: 'BUILDING', color: endpoint === 'origin' ? '#0067c0' : '#c52a3a'}, geometry: value.place.geometry});
      const element = document.createElement('button'); element.type = 'button'; element.className = `navigation-pin ${endpoint}`;
      element.append(controlIcon(endpoint === 'origin' ? 'map-pin' : 'flag'));
      element.setAttribute('aria-label', text(endpoint === 'origin' ? 'start' : 'end'));
      const marker = new maplibregl.Marker({element, draggable: true, anchor: 'bottom', offset: [0, -5]})
        .setLngLat(geo(value.position)).addTo(this.map);
      marker.on('dragstart', () => { this.cancel(); this.resetResults();
        const source = this.map.getSource('navigation') as GeoJSONSource | undefined; source?.setData(this.renderCollection([])); });
      marker.on('drag', () => {
        window.clearTimeout(this.previewTimer);
        const operation = this.operation;
        this.previewTimer = window.setTimeout(() => {
          const point = marker.getLngLat(), position: XYZ = [point.lat*111195, 0, -point.lng*111195];
          void this.ensureClient().then(client => client.snap(position, this.profile)).then(snaps => {
            if (operation !== this.operation) return;
            const source = this.map.getSource('navigation') as GeoJSONSource | undefined;
            source?.setData(this.renderCollection([{type: 'Feature', properties: {mode: 'ACCESS'},
              geometry: {type: 'LineString', coordinates: [geo(position), geo(snaps[0].position)]}}]));
          }).catch(error => this.fail(error, operation));
        }, 150);
      });
      marker.on('dragend', () => { const point = marker.getLngLat(); this.picking = endpoint; void this.choose([point.lat*111195, 0, -point.lng*111195], this.placeAt(this.map.project(point))); });
      this.marks.push(marker);
      if (!value.snap.geometryRef.startsWith('inside:')) features.push({type: 'Feature', properties: {mode: 'ACCESS'}, geometry: {type: 'LineString', coordinates: [geo(value.position), geo(value.snap.position)]}});
    }
    const collection = this.renderCollection(features);
    const source = this.map.getSource('navigation') as GeoJSONSource | undefined;
    if (source) { this.map.removeFeatureState({source: 'navigation'}); source.setData(collection); }
    else {
      if (!this.loader) return;
      // 短线段参与进度着色，不能由瓦片简化按长度过滤。
      this.map.addSource('navigation', {type: 'geojson', data: collection, tolerance: 0});
      for (const [id, casing] of [[lineIds[11], true], [lineIds[12], false]] as const)
        this.map.addLayer({id, type: 'line', source: 'navigation', filter: ['==', ['get', 'alternative'], true],
          layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {
            'line-color': casing ? '#869AAE' : alternativeRouteColor, 'line-opacity': 1,
            'line-color-transition': {duration: 0}, 'line-width': this.roadStyle.width(casing)}});
      this.map.addLayer({id: lineIds[0], type: 'line', source: 'navigation', filter: ['all', ['!=', ['get', 'alternative'], true], ['in', ['get', 'mode'], ['literal', ['GROUND', 'ELEVATED', 'TUNNEL', 'RIDE']]]], layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': ['case', ['==', ['get', 'mode'], 'RIDE'], 'rgba(255, 255, 255, 0.6)', '#195ba5'], 'line-width': this.roadStyle.width(true)}});
      this.map.addLayer({id: lineIds[1], type: 'line', source: 'navigation', filter: ['all', ['!=', ['get', 'alternative'], true], ['in', ['get', 'mode'], ['literal', ['GROUND', 'ELEVATED', 'TUNNEL']]]], layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': currentRouteColor, 'line-color-transition': {duration: 0}, 'line-width': this.roadStyle.width(false)}});
      this.map.addLayer({id: lineIds[2], type: 'line', source: 'navigation', filter: ['==', ['get', 'mode'], 'ACCESS'], paint: {'line-color': '#64748b', 'line-width': 1.6, 'line-dasharray': [2, 2]}});
      this.map.addLayer({id: lineIds[3], type: 'fill', source: 'navigation', filter: ['==', ['get', 'mode'], 'BUILDING'], paint: {'fill-color': ['get', 'color'], 'fill-opacity': .25}});
      this.map.addLayer({id: lineIds[4], type: 'line', source: 'navigation', filter: ['==', ['get', 'mode'], 'BUILDING'], paint: {'line-color': ['get', 'color'], 'line-width': 3}});
      this.map.addLayer({id: lineIds[5], type: 'line', source: 'navigation', filter: ['all', ['==', ['get', 'mode'], 'RIDE'], ['!=', ['get', 'schematic'], true]], layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': ['get', 'color'], 'line-width': scaledTransitWidth(factor => 4.8 * factor)}});
      this.map.addLayer({id: lineIds[6], type: 'line', source: 'navigation', filter: ['==', ['get', 'mode'], 'WALK'], paint: {'line-color': '#64748b', 'line-width': 3.2, 'line-dasharray': [1, 1]}});
      this.map.addLayer({id: lineIds[7], type: 'line', source: 'navigation', filter: ['all', ['==', ['get', 'mode'], 'RIDE'], ['==', ['get', 'schematic'], true]], paint: {'line-color': ['get', 'color'], 'line-width': scaledTransitWidth(factor => 4.8 * factor), 'line-dasharray': [2, 1]}});
      this.map.addLayer({id: lineIds[8], type: 'circle', source: 'navigation', filter: ['==', ['get', 'mode'], 'STOP'],
        layout: {'circle-sort-key': ['case', ['==', ['get', 'endpoint'], true], 1, 0]},
        paint: {'circle-color': '#ffffff', 'circle-radius': ['case', ['==', ['get', 'endpoint'], true], 5, 4.5],
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2}});
      const arrowFilter: ExpressionSpecification = ['all', ['==', ['get', 'mode'], 'TURN_ARROW'], ['>=', ['zoom'], ['get', 'minZoom']]];
      const arrowOpacity: ExpressionSpecification = ['case', ['boolean', ['feature-state', 'completed'], false], 0, 1];
      this.map.addLayer({id: lineIds[9], type: 'fill', source: 'navigation', filter: arrowFilter,
        paint: {'fill-color': '#ffffff', 'fill-opacity': arrowOpacity, 'fill-opacity-transition': {duration: 0}}});
      this.map.addLayer({id: lineIds[10], type: 'line', source: 'navigation', filter: arrowFilter,
        layout: {'line-join': 'round'}, paint: {'line-color': '#195ba5', 'line-width': arrowOutlineWidth,
          'line-opacity': arrowOpacity, 'line-opacity-transition': {duration: 0}}});
    }
    const progress = this.progressMeters;
    this.progressMeters = NaN; this.completedStrokes = 0; this.completedArrows = 0;
    this.simulation.setRouteStrokes(this.routeStrokes);
    this.drawProgress(this.simulation.active ? progress : null);
    this.simulation.refreshBuildings();
  }

  private drawProgress(meters: number | null): void {
    if ((this.progressMeters === null) !== (meters === null)) {
      for (const id of ['navigation-alternative-casing', 'navigation-alternative-road'])
        if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', meters === null ? 'visible' : 'none');
      this.updateRoutePopup(meters);
    }
    if (this.progressMeters === meters) return;
    this.progressMeters = meters;
    const target = meters ?? -1;
    while (this.completedArrows > 0 && this.routeArrows[this.completedArrows-1].properties!.passedAt > target) {
      const feature = this.routeArrows[--this.completedArrows];
      this.map.setFeatureState({source: 'navigation', id: feature.id!}, {completed: false});
    }
    while (this.completedArrows < this.routeArrows.length && this.routeArrows[this.completedArrows].properties!.passedAt <= target) {
      const feature = this.routeArrows[this.completedArrows++];
      this.map.setFeatureState({source: 'navigation', id: feature.id!}, {completed: true});
    }
    while (this.completedStrokes > 0 && this.routeStrokes[this.completedStrokes-1].properties!.routeEnd > target) {
      const feature = this.routeStrokes[--this.completedStrokes];
      this.map.setFeatureState({source: 'navigation', id: feature.id!}, {completed: false});
    }
    while (this.completedStrokes < this.routeStrokes.length && this.routeStrokes[this.completedStrokes].properties!.routeEnd <= target) {
      const feature = this.routeStrokes[this.completedStrokes++];
      this.map.setFeatureState({source: 'navigation', id: feature.id!}, {completed: true});
    }
  }

  refreshStyle(): void {
    if (this.result) this.draw();
    for (const [id, casing] of [['navigation-casing', true], ['navigation-road', false],
      ['navigation-alternative-casing', true], ['navigation-alternative-road', false]] as const)
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-width', this.roadStyle.width(casing));
    this.simulation.refreshBuildings();
  }
}
