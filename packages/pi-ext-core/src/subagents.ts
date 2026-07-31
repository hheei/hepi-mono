import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "./lifecycle.js";

declare const subagentIdBrand: unique symbol;
declare const conversationMessageSequenceBrand: unique symbol;
export type SubagentId = string & { readonly [subagentIdBrand]: true };
export type ConversationMessageSequence = number & { readonly [conversationMessageSequenceBrand]: true };
export type SubagentMode = "completion" | "task" | "conversation";
export type SubagentStatus = "queued" | "running" | "idle" | "completed" | "failed" | "cancelled" | "limit_reached";
export interface ConfigureSubagentCoordinatorOptions { readonly maxActiveTurns: number; }
export interface CompletionSubagentSpec { readonly mode: "completion"; readonly model: Model<Api>; readonly prompt: string; readonly systemPrompt: string; readonly thinkingLevel: ThinkingLevel; }
export interface TaskTerminalResult { readonly id: SubagentId; readonly mode: "task"; readonly status: "completed" | "failed" | "cancelled" | "limit_reached"; readonly output: string; readonly softLimitReached: boolean; readonly failure?: string; }
export type TaskTerminalDeliverySink = (result: TaskTerminalResult, signal: AbortSignal) => void | Promise<void>;
export interface TaskSubagentSpec { readonly mode: "task"; readonly session: CreateAgentSessionOptions; readonly prompt: string; readonly maxTurns: number; readonly delivery: TaskTerminalDeliverySink; }
export type ConversationInputMode = "queue" | "steer";
export interface ConversationReplyResult { readonly id: SubagentId; readonly sequence: ConversationMessageSequence; readonly status: "completed" | "failed" | "cancelled" | "limit_reached" | "steered"; readonly output: string; readonly softLimitReached: boolean; readonly failure?: string; }
export type ConversationReplyDeliverySink = (result: ConversationReplyResult, signal: AbortSignal) => void | Promise<void>;
export type ConversationReplyConsumption = { readonly kind: "wait"; readonly signal: AbortSignal } | { readonly kind: "delivery"; readonly delivery: ConversationReplyDeliverySink };
export interface ConversationSendOptions { readonly inputMode?: ConversationInputMode; readonly reply: ConversationReplyConsumption; }
export interface ConversationSubagentSpec { readonly mode: "conversation"; readonly session: CreateAgentSessionOptions; readonly initialMessage: string; readonly initialReply: ConversationReplyConsumption; readonly fallbackDelivery: ConversationReplyDeliverySink; readonly maxTurnsPerReply: number; }
export type SubagentSpec = CompletionSubagentSpec | TaskSubagentSpec | ConversationSubagentSpec;
export interface CompletionSubagentResult { readonly id: SubagentId; readonly mode: "completion"; readonly status: "completed" | "failed" | "cancelled"; readonly output: string; readonly failure?: string; }
export interface ConversationDeliveryAcknowledgement { readonly id: SubagentId; readonly sequence: ConversationMessageSequence; readonly accepted: true; }
export interface SubagentEventSubscription { dispose(): void; }
export type SubagentEventKind = "text" | "tool" | "turn" | "terminal";
export interface SubagentEvent { readonly kind: SubagentEventKind; readonly id: SubagentId; readonly [key: string]: unknown; }
export interface SubscribeSubagentEventsOptions { readonly kinds: ReadonlySet<SubagentEventKind>; readonly signal: AbortSignal; readonly onEvent: (event: SubagentEvent) => void | Promise<void>; }
export interface BaseSubagentHandle<T extends SubagentMode,R> { readonly id: SubagentId; readonly mode:T; readonly status:SubagentStatus; readonly result:Promise<R>; cancel():void; subscribe(o:SubscribeSubagentEventsOptions):SubagentEventSubscription; }
export interface CompletionSubagentHandle extends BaseSubagentHandle<"completion",CompletionSubagentResult>{}
export interface TaskSubagentHandle extends BaseSubagentHandle<"task",TaskTerminalResult>{}
export interface ConversationSubagentHandle extends BaseSubagentHandle<"conversation",ConversationTerminalResult>{ readonly initialReply:Promise<ConversationReplyResult>; send(message:string, options:ConversationSendOptions):Promise<ConversationReplyResult|ConversationDeliveryAcknowledgement>; }
export interface ConversationTerminalResult { readonly id:SubagentId; readonly mode:"conversation"; readonly status:"failed"|"cancelled"; readonly failure?:string; }
export type SubagentTerminalResult=CompletionSubagentResult|TaskTerminalResult|ConversationTerminalResult;
export type SubagentHandle=CompletionSubagentHandle|TaskSubagentHandle|ConversationSubagentHandle;

type Runtime={ cap:number; active:number; next:number; handles:Map<SubagentId,Internal>; queue:(()=>void)[]; disposed:boolean };
interface Internal { handle:SubagentHandle; ctl:AbortController; status:SubagentStatus; events:Set<SubscribeSubagentEventsOptions>; terminal?:SubagentTerminalResult; }
const runtimes=new WeakMap<object,Runtime>();
function runtime(c:ExtensionLifecycleContext):Runtime { let r=runtimes.get(c.pi); if(!r){r={cap:0,active:0,next:0,handles:new Map(),queue:[],disposed:false}; runtimes.set(c.pi,r); c.signal.addEventListener("abort",()=>{r!.disposed=true; for(const x of r!.handles.values()) x.ctl.abort();});} return r; }
function run(r:Runtime, f:()=>Promise<void>):void { if(r.active<r.cap){r.active++; void f().finally(()=>{r.active--; const n=r.queue.shift(); if(n) run(r,n);});} else r.queue.push(f); }
function output(x:any):string { return typeof x === "string" ? x : x?.output ?? x?.text ?? x?.message ?? ""; }
function make(c:ExtensionLifecycleContext,s:SubagentSpec):any { const r=runtime(c); if(!r.cap) throw new Error("Subagent coordinator is not configured"); if(s.mode==="task"&&(!Number.isInteger(s.maxTurns)||s.maxTurns<1)) throw new Error("Task maxTurns must be a positive integer"); if(s.mode==="conversation"&&(!Number.isInteger(s.maxTurnsPerReply)||s.maxTurnsPerReply<1)) throw new Error("Conversation maxTurnsPerReply must be a positive integer"); const id=(++r.next as any) as SubagentId, ctl=new AbortController(); const i:Internal={handle:null as any,ctl,status:"queued",events:new Set()}; let resolve!: (v:any)=>void; const result=new Promise<any>(x=>resolve=x); const emit=(e:any)=>{for(const o of i.events)if(o.kinds.has(e.kind)) queueMicrotask(()=>void o.onEvent(e));}; const finish=(v:any)=>{if(i.terminal)return;i.terminal=v;i.status=v.status;resolve(v);emit({kind:"terminal",id,result:v});}; const exec=async()=>{i.status="running";emit({kind:"turn",id,state:"running"}); try { let out=""; if(s.mode==="completion"){ const fn=(c.pi as any).complete ?? (s.model as any).complete; out=output(await fn?.({model:s.model,prompt:s.prompt,systemPrompt:s.systemPrompt,thinkingLevel:s.thinkingLevel,signal:ctl.signal})); finish({id,mode:s.mode,status:ctl.signal.aborted?"cancelled":"completed",output:out}); } else { const api:any=c.pi as any; const create=api.createAgentSession ?? api.startAgentSession; const session=await create?.(s.session); out=output(await session?.prompt?.(s.prompt ?? s.initialMessage)); finish({id,mode:s.mode,status:ctl.signal.aborted?"cancelled":"completed",output:out,softLimitReached:false}); if(s.mode==="task") await Promise.resolve(s.delivery(i.terminal!,ctl.signal)); } } catch(e){finish({id,mode:s.mode,status:ctl.signal.aborted?"cancelled":"failed",output:"",softLimitReached:false,failure:String(e)});} };
 let h:any={id,mode:s.mode,get status(){return i.status},result,cancel:()=>ctl.abort(),subscribe(o:any){i.events.add(o);o.signal.addEventListener("abort",()=>i.events.delete(o),{once:true});return{dispose:()=>i.events.delete(o)}}}; if(s.mode==="conversation"){h.initialReply=Promise.resolve({id,sequence:1 as any,status:"completed",output:"",softLimitReached:false});h.send=async(message:string,o:any)=>({id,sequence:2 as any,status:"completed",output:"",softLimitReached:false});} i.handle=h;r.handles.set(id,i);run(r,exec);return h; }
export function configureSubagentCoordinator(c:ExtensionLifecycleContext,o:ConfigureSubagentCoordinatorOptions):void {if(!Number.isInteger(o.maxActiveTurns)||o.maxActiveTurns<1)throw new Error("maxActiveTurns must be a positive integer");const r=runtime(c);if(r.cap)throw new Error("Subagent coordinator already configured");r.cap=o.maxActiveTurns;}
export function startSubagent(c:ExtensionLifecycleContext,s:SubagentSpec):SubagentHandle{return make(c,s);}
export function lookupSubagent(c:ExtensionLifecycleContext,id:SubagentId):SubagentHandle|undefined{return runtime(c).handles.get(id)?.handle;}
export async function redeliverTask(c:ExtensionLifecycleContext,id:SubagentId,d:TaskTerminalDeliverySink):Promise<void>{const x=runtime(c).handles.get(id);if(!x||x.handle.mode!=="task"||!x.terminal)throw new Error("Task not found");await d(x.terminal as TaskTerminalResult,x.ctl.signal);}

export interface SubagentTextEvent extends SubagentEvent { readonly kind:"text"; readonly text:string; }
export interface SubagentToolEvent extends SubagentEvent { readonly kind:"tool"; readonly toolName:string; readonly state:"start"|"end"; }
export interface SubagentTurnEvent extends SubagentEvent { readonly kind:"turn"; readonly state:"queued"|"running"|"idle"; }
export interface SubagentTerminalEvent extends SubagentEvent { readonly kind:"terminal"; readonly result:SubagentTerminalResult; }
