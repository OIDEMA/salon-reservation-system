import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { assertAccessAssignment, canManageMember, effectivePermissions, hasPermission, PERMISSIONS } from "../src/permissions.js";
import { assertInvitationUsable, hashInvitationToken, registerAccessRoutes } from "../src/access-routes.js";
import { deriveInvitationToken } from "../src/invitation-token.js";

const invitationTestKey = "unit-test-invitation-token-key-32-bytes";

async function withInvitationKey<T>(action: () => Promise<T>) {
  const original = process.env.INVITATION_TOKEN_KEY;
  process.env.INVITATION_TOKEN_KEY = invitationTestKey;
  try { return await action(); }
  finally {
    if (original === undefined) delete process.env.INVITATION_TOKEN_KEY;
    else process.env.INVITATION_TOKEN_KEY = original;
  }
}

const owner = {userId:"owner",role:"OWNER",status:"ACTIVE",useCustomPermissions:true,permissions:[],salonIds:["a"]};
const admin = {userId:"admin",role:"ADMIN",status:"ACTIVE",useCustomPermissions:true,permissions:["access.manage","reservation.read","customer.read"],salonIds:["a"]};
const viewer = {userId:"viewer",role:"VIEWER",status:"ACTIVE",useCustomPermissions:false,permissions:[],salonIds:["a"]};
const assignment = {role:"STAFF",status:"ACTIVE",useCustomPermissions:true,permissions:["reservation.read"],salonIds:["a"]};
const policyError = (code:string) => (error:unknown) => error instanceof Error && "code" in error && error.code === code;

test("OWNER is unrestricted while suspended memberships have no permissions",()=>{
  assert.deepEqual(effectivePermissions(owner), [...PERMISSIONS]);
  assert.deepEqual(effectivePermissions({...owner,status:"SUSPENDED"}),[]);
  assert(hasPermission(owner,"checkout.refund"));
});
test("VIEWER cannot write and unknown/custom permissions fail closed",()=>{
  assert(!hasPermission(viewer,"reservation.write"));assert(hasPermission(viewer,"reservation.read"));
  assert.deepEqual(effectivePermissions({...viewer,useCustomPermissions:true,permissions:["unknown","checkout.read"]}),["checkout.read"]);
  assert.deepEqual(effectivePermissions({role:"unknown"}),[]);
  assert(!hasPermission({...assignment,permissions:["access.manage"]},"access.manage"));
  assert(!hasPermission({...viewer,useCustomPermissions:true,permissions:["reservation.write"]},"reservation.write"));
  assert(hasPermission({...assignment,permissions:["chart.write"]},"chart.read"));
  assert(hasPermission({...assignment,permissions:["checkout.refund"]},"checkout.read"));
  assert(hasPermission({...assignment,permissions:["register.close"]},"register.read"));
});
test("self changes and ADMIN promotion to OWNER are denied",()=>{
  assert.throws(()=>assertAccessAssignment(owner,"owner",owner,assignment,["a","b"]),policyError("SELF_ACCESS_CHANGE_DENIED"));
  assert.throws(()=>assertAccessAssignment(admin,"other",undefined,{...assignment,role:"OWNER"},["a","b"]),policyError("OWNER_ACCESS_CHANGE_DENIED"));
});
test("ADMIN cannot grant rights or salons beyond its own",()=>{
  assertAccessAssignment(admin,"other",undefined,assignment,["a","b"]);
  assert.throws(()=>assertAccessAssignment(admin,"other",undefined,{...assignment,permissions:["checkout.refund"]},["a","b"]),policyError("PERMISSION_ESCALATION_DENIED"));
  assert.throws(()=>assertAccessAssignment(admin,"other",undefined,{...assignment,salonIds:[]},["a","b"]),policyError("SALON_ESCALATION_DENIED"));
  assert.throws(()=>assertAccessAssignment(owner,"other",undefined,{...assignment,salonIds:["foreign"]},["a","b"]),policyError("INVALID_SALON_SCOPE"));
});
test("ADMIN cannot shrink an existing target outside its authority",()=>{
  assert.throws(()=>assertAccessAssignment(admin,"other",{...assignment,salonIds:["b"]},assignment,["a","b"]),policyError("TARGET_SALON_OUT_OF_SCOPE"));
  assert.throws(()=>assertAccessAssignment(admin,"other",{...assignment,permissions:["checkout.refund"]},assignment,["a","b"]),policyError("TARGET_PERMISSION_OUT_OF_SCOPE"));
  assert(!canManageMember(admin,{...assignment,userId:"other",salonIds:[]}));
  assert(!canManageMember(admin,{...owner,userId:"other"}));
  assert(canManageMember(admin,{...assignment,userId:"other"}));
});

test("invite hash does not store the bearer token",()=>{
  const token="a".repeat(43);assert.equal(hashInvitationToken(token).length,64);assert.notEqual(hashInvitationToken(token),token);
  assert.equal(hashInvitationToken(token),hashInvitationToken(token));assert.notEqual(hashInvitationToken(token),hashInvitationToken("b".repeat(43)));
});
test("invitation token is deterministic, secret-bound and 43 characters", () => {
  const source = { id: "invitation-id", email: "Staff@Example.test", expiresAt: new Date("2030-01-01T00:00:00Z") };
  const token = deriveInvitationToken(source, invitationTestKey);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, deriveInvitationToken({ ...source, email: "staff@example.test" }, invitationTestKey));
  assert.notEqual(token, deriveInvitationToken({ ...source, id: "different" }, invitationTestKey));
  assert.notEqual(token, deriveInvitationToken(source, `${invitationTestKey}-different`));
  assert.throws(() => deriveInvitationToken(source, "too-short"), /INVITATION_TOKEN_KEY/);
});
test("invite requires matching verified identity email and is single use, revocable and expiring",()=>{
  const now=new Date("2030-01-01T00:00:00Z");const invitation={email:"Staff@example.com",expiresAt:new Date(now.getTime()+1),acceptedAt:null,revokedAt:null};
  assertInvitationUsable(invitation,"staff@example.com",now);
  assert.throws(()=>assertInvitationUsable(invitation,"other@example.com",now),policyError("INVITATION_EMAIL_MISMATCH"));
  assert.throws(()=>assertInvitationUsable(invitation,null,now),policyError("INVITATION_EMAIL_MISMATCH"));
  for(const value of [{...invitation,acceptedAt:now},{...invitation,revokedAt:now},{...invitation,expiresAt:now}]) {
    assert.throws(()=>assertInvitationUsable(value,"staff@example.com",now),policyError("INVITATION_UNAVAILABLE"));
  }
});

function fixture() {
  const tenant={id:"t",slug:"salon",name:"Salon",status:"ACTIVE"};
  const ownerUser={id:"owner",email:"owner@example.com",displayName:"Owner",disabled:false};
  const newUser={id:"new",email:"new@example.com",displayName:"New",disabled:false};
  let state={members:[{...owner,tenantId:"t",user:ownerUser,tenant}],invitations:[] as any[],outbox:[] as any[],audits:[] as any[],locks:0};
  const matches=(item:any,where:any)=> (!where?.id||item.id===where.id)&&(!where?.tenantId||item.tenantId===where.tenantId)&&
    (!where?.tokenHash||item.tokenHash===where.tokenHash)&&(!where?.email||item.email===where.email)&&
    (where?.acceptedAt!==null||item.acceptedAt===null)&&(where?.revokedAt!==null||item.revokedAt===null);
  const db:any={
    $queryRaw:async()=>{state.locks++;return[];},
    appUser:{findUnique:async({where}:any)=>where.id===newUser.id?newUser:where.id===ownerUser.id?ownerUser:null},
    salon:{findMany:async()=>[{id:"a",name:"A"},{id:"b",name:"B"}]},
    tenantMembership:{
      findUnique:async({where}:any)=>state.members.find(member=>member.tenantId===where.tenantId_userId.tenantId&&member.userId===where.tenantId_userId.userId)??null,
      findFirst:async({where}:any)=>state.members.find(member=>member.tenantId===where.tenantId&&member.user.email===where.user.email)??null,
      findMany:async()=>state.members,
      count:async()=>state.members.filter(member=>member.role==="OWNER"&&member.status==="ACTIVE"&&!member.user.disabled).length,
      create:async({data}:any)=>{const member={...data,user:newUser,tenant};state.members.push(member);return member;},
      update:async({where,data}:any)=>{const member=state.members.find(item=>item.userId===where.tenantId_userId.userId)!;Object.assign(member,data);return member;}
    },
    tenantInvitation:{
      findUnique:async({where}:any)=>state.invitations.find(item=>matches(item,where))??null,
      findFirst:async({where}:any)=>state.invitations.find(item=>matches(item,where))??null,
      findMany:async()=>state.invitations,
      create:async({data}:any)=>{const invitation={...data,createdAt:new Date(),acceptedAt:null,revokedAt:null,tenant};state.invitations.push(invitation);return invitation;},
      update:async({where,data}:any)=>{const invitation=state.invitations.find(item=>matches(item,where));Object.assign(invitation,data);return invitation;},
      updateMany:async({where,data}:any)=>{const list=state.invitations.filter(item=>matches(item,where)&&(!where.expiresAt||item.expiresAt>where.expiresAt.gt));for(const item of list)Object.assign(item,data);return{count:list.length};}
    },
    emailOutbox:{create:async({data}:any)=>{state.outbox.push(data);return data;}},
    auditLog:{create:async({data}:any)=>{state.audits.push(data);return data;},findMany:async()=>[]},
    $transaction:async(callback:any)=>{const previous=structuredClone(state);try{return await callback(db);}catch(error){state=previous;throw error;}}
  };
  const context={tenant,user:ownerUser,membership:state.members[0]} as any;
  return {db:db as PrismaClient,context,newUser,getState:()=>state};
}

test("HTTP invite creation stores only a hash and acceptance needs no prior membership",async()=>withInvitationKey(async()=>{
  const fixtureData=fixture();const app=Fastify();
  registerAccessRoutes(app,{database:fixtureData.db,authorize:async()=>fixtureData.context,authenticate:async()=>fixtureData.newUser as any});
  const created=await app.inject({method:"POST",url:"/api/access/invitations",payload:{email:"new@example.com",...assignment, status:undefined}});
  assert.equal(created.statusCode,201);const body=created.json();
  assert(!JSON.stringify(body).includes("tokenHash"));assert.equal(body.acceptPath,undefined);
  const stored=fixtureData.getState().invitations[0];
  const token=deriveInvitationToken(stored,invitationTestKey);assert.equal(stored.tokenHash,hashInvitationToken(token));
  assert.equal(fixtureData.getState().outbox.length,1);
  assert.equal(fixtureData.getState().outbox[0].eventKey,`invitation.created:${stored.id}`);
  assert.equal(fixtureData.getState().outbox[0].recipientEmail,"new@example.com");
  assert(!JSON.stringify(fixtureData.getState().outbox).includes(token));
  const accepted=await app.inject({method:"POST",url:"/api/access/invitations/accept",payload:{token}});
  assert.equal(accepted.statusCode,200);assert.equal(accepted.json().tenant.slug,"salon");
  assert.equal(fixtureData.getState().members.filter(member=>member.userId==="new").length,1);
  const repeat=await app.inject({method:"POST",url:"/api/access/invitations/accept",payload:{token}});assert.equal(repeat.statusCode,410);
  assert(fixtureData.getState().locks>=2);assert(!JSON.stringify(fixtureData.getState().audits).includes(token));await app.close();
}));
test("HTTP mismatching identity, cancellation and lost inviter authority deny acceptance",async()=>withInvitationKey(async()=>{
  const f=fixture();const app=Fastify();let identity={...f.newUser,email:"wrong@example.com"};
  registerAccessRoutes(app,{database:f.db,authorize:async()=>f.context,authenticate:async()=>identity as any});
  const create=async()=>{const response=await app.inject({method:"POST",url:"/api/access/invitations",payload:{email:"new@example.com",...assignment,status:undefined}});assert.equal(response.statusCode,201);const body=response.json();const stored=f.getState().invitations.find((item)=>item.id===body.invitation.id);return {...body,token:deriveInvitationToken(stored,invitationTestKey)};};
  const first=await create();const token=first.token;
  assert.equal((await app.inject({method:"POST",url:"/api/access/invitations/accept",payload:{token}})).statusCode,403);
  assert.equal((await app.inject({method:"DELETE",url:`/api/access/invitations/${first.invitation.id}`})).statusCode,200);
  identity=f.newUser;assert.equal((await app.inject({method:"POST",url:"/api/access/invitations/accept",payload:{token}})).statusCode,410);
  const second=await create();f.getState().members[0].status="SUSPENDED";
  assert.equal((await app.inject({method:"POST",url:"/api/access/invitations/accept",payload:{token:second.token}})).statusCode,403);
  assert.equal(f.getState().members.length,1);await app.close();
}));
test("missing invitation token key fails before revocation or outbox writes",async()=>{
  const f=fixture();const app=Fastify();
  registerAccessRoutes(app,{database:f.db,authorize:async()=>f.context});
  const original=process.env.INVITATION_TOKEN_KEY;
  delete process.env.INVITATION_TOKEN_KEY;
  try {
    const response=await app.inject({method:"POST",url:"/api/access/invitations",payload:{email:"new@example.com",...assignment,status:undefined}});
    assert.equal(response.statusCode,500);
    assert.equal(f.getState().invitations.length,0);
    assert.equal(f.getState().outbox.length,0);
    assert.equal(f.getState().locks,0);
  } finally {
    if (original !== undefined) process.env.INVITATION_TOKEN_KEY=original;
    await app.close();
  }
});
test("HTTP authorization fails before access data is queried",async()=>{
  const app=Fastify();let calls=0;
  registerAccessRoutes(app,{database:{} as PrismaClient,authorize:async(_request,reply,permission)=>{assert.equal(permission,"access.manage");calls++;reply.code(403).send({message:"denied"});return null;}});
  assert.equal((await app.inject({method:"GET",url:"/api/access/members"})).statusCode,403);assert.equal(calls,1);await app.close();
});
