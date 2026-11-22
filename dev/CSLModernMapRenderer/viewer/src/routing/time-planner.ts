import FlatQueue from 'flatqueue';
import {RoutingError} from './types';
import type {Edge, NavigationPackage, Snap, TransitPreference, TransitTransfer, RouteResult} from './types';
import {isBoarding} from './itinerary';

export const WALK_SECONDS_PER_METER = 16 * 60 / 1000;
const specs: Record<string, number[]> = {
  TRAIN: [120,.8,.8,45,1,90], METRO: [80,1,1,30,1,60],
  MONORAIL: [50,1,1,30,1,60], BUS: [40,.8,1,20,1.3,60]
};
const vehicle = (e: Edge) => specs[e.transitKind ?? ''] ?? specs.BUS;
export const dwellSeconds = (edge: Edge): number => vehicle(edge)[3];
export function runningSeconds(e: Edge): number {
  const [kmh,a,b,,factor] = vehicle(e), v=kmh/3.6, d=e.lengthM;
  const d0=v*v/(2*a)+v*v/(2*b);
  return factor*(d>=d0 ? v/a+v/b+(d-d0)/v : Math.sqrt(2*d*(a+b)/(a*b)));
}
type Step = RouteResult['traversals'][number];
type Tree = {dist: Float64Array; prev: Int32Array; seeds: Map<number,Step[]>};
type RideTiming = {traversalStart: number; stopSeconds: number[]; transfer?: TransitTransfer};
const full = (e:Edge):Step => ({edgeId:e.id,fromFraction:0,toFraction:1});

export class TimePlanner {
  private ids=new Map<string,number>();
  private adj:number[][];
  private feet:Edge[]=[];
  private ends:number[]=[];
  private refs=new Map<string,number[]>();
  private rides:Edge[]=[];
  private trees=new Map<string,Tree>();
  private owners=new Map<string,Set<string>>();
  constructor(data:NavigationPackage) {
    for (const node of Object.keys(data.nodes)) this.ids.set(node,this.ids.size);
    this.adj=Array.from(this.ids,()=>[]);
    for(const [key,obj] of Object.entries(data.stationObjects ?? {})) for(const id of obj.platforms){
      const stop='stop:'+id, keys=this.owners.get(stop) ?? new Set<string>();keys.add(key);this.owners.set(stop,keys);
    }
    for(const e of data.edges){
      if(e.mode==='RIDE'){this.rides.push(e);continue;}
      const i=this.feet.length;this.feet.push(e);this.ends.push(this.ids.get(e.toNode)!);
      this.adj[this.ids.get(e.fromNode)!].push(i);
      const refs=this.refs.get(e.geometryRef) ?? [];refs.push(i);this.refs.set(e.geometryRef,refs);
    }
  }
  private tree(start:string|Snap):Tree {
    if(typeof start==='string' && this.trees.has(start))return this.trees.get(start)!;
    const dist=new Float64Array(this.ids.size).fill(Infinity),prev=new Int32Array(this.ids.size).fill(-1);
    const seeds=new Map<number,Step[]>(),q=new FlatQueue();
    const seed=(id:number,d:number,path:Step[])=>{if(d<dist[id]){dist[id]=d;seeds.set(id,path);q.push(id,d);}};
    if(typeof start==='string')seed(this.ids.get(start)!,0,[]);
    else for(const i of this.refs.get(start.geometryRef) ?? []){
      const e=this.feet[i],f=e.reverse?1-start.fraction:start.fraction;
      seed(this.ends[i],(1-f)*(e.stationObject?0:e.lengthM),f<1?[{...full(e),fromFraction:f}]:[]);
    }
    while(q.length){
      const d=q.peekValue()!,u=q.pop()!;if(d!==dist[u])continue;
      for(const i of this.adj[u]){
        const e=this.feet[i],v=this.ends[i],n=d+(e.stationObject?0:e.lengthM);
        if(n<dist[v]){dist[v]=n;prev[v]=i;q.push(v,n);}
      }
    }
    const tree={dist,prev,seeds};if(typeof start==='string')this.trees.set(start,tree);return tree;
  }
  private path(t:Tree,node:number):Step[]{
    const path:Step[]=[];
    while(t.prev[node]>=0){const e=this.feet[t.prev[node]];path.push(full(e));node=this.ids.get(e.fromNode)!;}
    return [...(t.seeds.get(node) ?? []),...path.reverse()];
  }
  private reverse(path:Step[]):Step[]{
    return path.reverse().map(s=>({edgeId:s.edgeId.slice(0,-1)+(s.edgeId.endsWith(':f')?'b':'f'),
      fromFraction:1-s.toFraction,toFraction:1-s.fromFraction}));
  }
  private transfer(from: Edge, to: Edge, meters: number): TransitTransfer {
    const sameStation = from.toNode === to.fromNode ||
      [...(this.owners.get(from.toNode) ?? [])].some(owner => this.owners.get(to.fromNode)?.has(owner));
    const walkingDistanceM = sameStation ? 0 : Math.max(100, meters);
    const connectionSeconds = sameStation ? 60 : walkingDistanceM * WALK_SECONDS_PER_METER;
    return {sameStation, walkingDistanceM, durationSeconds: connectionSeconds + vehicle(to)[5]};
  }
  solve(a:Snap,b:Snap,preference:TransitPreference,avoid?:string){
    const start=this.tree(a),end=this.tree(b),rides=this.rides;
    const walkBias=preference==='less-walking'?1.5:1;
    const transferBias=preference==='fewer-transfers'?300:0;
    const index=(node:string)=>this.ids.get(node)!;
    const cost=new Float64Array(rides.length).fill(Infinity),time=cost.slice();
    const parent=new Int32Array(rides.length).fill(-1),through=new Uint8Array(rides.length);
    const q=new FlatQueue(),run=rides.map(runningSeconds);
    for(let i=0;i<rides.length;i++){
      const e=rides[i],walk=start.dist[index(e.fromNode)]*WALK_SECONDS_PER_METER;
      if(!Number.isFinite(walk)||e.lineId===avoid)continue;
      const train=vehicle(e)[5]+run[i];cost[i]=walk*walkBias+train;time[i]=walk+train;q.push(i,cost[i]);
    }
    let best=Infinity,seconds=Infinity,winner=-1,join=-1,direct:Step[]=[];
    // Endpoints may share a street, including two interior points on one edge.
    if(a.geometryRef===b.geometryRef)for(const i of this.refs.get(a.geometryRef) ?? []){
      const e=this.feet[i],f=e.reverse?1-a.fraction:a.fraction,g=e.reverse?1-b.fraction:b.fraction;
      if(g<f)continue;
      seconds=(g-f)*(e.stationObject?0:e.lengthM)*WALK_SECONDS_PER_METER;
      best=seconds*walkBias;direct=g>f?[{...full(e),fromFraction:f,toFraction:g}]:[];break;
    }
    for(const i of this.refs.get(b.geometryRef) ?? []){
      const v=this.ends[i],walk=(start.dist[v]+end.dist[v])*WALK_SECONDS_PER_METER;
      if(walk*walkBias<best){best=walk*walkBias;seconds=walk;join=v;}
    }
    while(q.length && q.peekValue()!<best){
      const score=q.peekValue()!,i=q.pop()!;if(score!==cost[i])continue;
      const e=rides[i],last=index(e.toNode),exit=end.dist[last]*WALK_SECONDS_PER_METER;
      if(score+exit*walkBias<best){best=score+exit*walkBias;seconds=time[i]+exit;winner=i;}
      const foot=this.tree(e.toNode);
      for(let j=0;j<rides.length;j++){
        const next=rides[j];if(next.lineId===avoid)continue;
        const stay=!isBoarding(e,next) && e.toNode===next.fromNode;
        let transfer=0,walk=0;
        if(stay)transfer=dwellSeconds(e);
        else{
          const meters=foot.dist[index(next.fromNode)];if(!Number.isFinite(meters))continue;
          const connection = this.transfer(e, next, meters);
          walk = connection.walkingDistanceM * WALK_SECONDS_PER_METER;
          transfer = connection.durationSeconds - walk;
        }
        const increment=run[j]+transfer;
        const n=score+increment+walk*walkBias+(stay?0:transferBias);
        if(n<cost[j]&&n<best){
          cost[j]=n;time[j]=time[i]+increment+walk;parent[j]=i;through[j]=+stay;q.push(j,n);
        }
      }
    }
    if(!Number.isFinite(seconds))throw new RoutingError('NO_PATH');
    let steps:Step[];
    const rideTimings: RideTiming[] = [];
    if(winner<0)steps=join<0?direct:[...this.path(start,join),...this.reverse(this.path(end,join))];
    else{
      const seq:number[]=[];for(let i=winner;i>=0;i=parent[i])seq.push(i);seq.reverse();
      steps=this.path(start,index(rides[seq[0]].fromNode));
      for(const [k,i] of seq.entries()){
        const edge = rides[i];
        if (through[i]) {
          const timing = rideTimings.at(-1)!;
          timing.stopSeconds.push(timing.stopSeconds.at(-1)! + dwellSeconds(rides[seq[k-1]]) + run[i]);
        } else {
          let transfer: TransitTransfer | undefined;
          if (k > 0) {
            const previous = rides[seq[k-1]];
            const foot = this.tree(previous.toNode);
            const nextStop = index(edge.fromNode);
            steps.push(...this.path(foot, nextStop));
            transfer = this.transfer(previous, edge, foot.dist[nextStop]);
          }
          rideTimings.push({traversalStart: steps.length, stopSeconds: [0, run[i]], transfer});
        }
        steps.push(full(edge));
      }
      steps.push(...this.reverse(this.path(end,index(rides[winner].toNode))));
    }
    return {steps, rideTimings, seconds:seconds+(a.distanceM+b.distanceM)*WALK_SECONDS_PER_METER};
  }
}
