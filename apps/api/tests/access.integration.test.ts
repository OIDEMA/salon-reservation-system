import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { deriveInvitationToken } from "../src/invitation-token.js";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
if (testDatabaseUrl && !new URL(testDatabaseUrl).pathname.endsWith("_test")) {
  throw new Error("Access integration tests require an explicit database name ending in _test.");
}

test("access API with real PostgreSQL and Firebase verified identity", {skip: !testDatabaseUrl}, async(t)=>{
  process.env.DATABASE_URL = testDatabaseUrl!;
  const previousInvitationTokenKey=process.env.INVITATION_TOKEN_KEY;
  process.env.INVITATION_TOKEN_KEY="integration-test-invitation-token-key-32-bytes";
  const [{prisma},{firebaseAdminAuth},{registerAccessRoutes},{requirePermission},{requestedSalonId,requireAuthenticatedUser},{lockOperation,runSerializable}] = await Promise.all([
    import("../src/database.js"),import("../src/auth.js"),import("../src/access-routes.js"),import("../src/permissions.js"),import("../src/tenant-context.js"),import("../src/operations-support.js")
  ]);
  const prefix = `access-${randomUUID().slice(0,8)}`;
  const tenantIds:string[]=[];const userIds:string[]=[];
  const identities = new Map<string,{uid:string;email:string;email_verified:boolean;name:string}>();
  const credentialMock=t.mock.method(firebaseAdminAuth,"verifySessionCookie",async(credential:string)=>{
    const identity=identities.get(credential);assert(identity,"test identity missing");return identity;
  });
  const app=Fastify({logger:false});
  app.setErrorHandler((error,_request,reply)=>reply.code(error.statusCode??500).send({message:error.message}));
  registerAccessRoutes(app);
  app.get("/test/read",async(request,reply)=>{const context=await requirePermission(request,reply,"reservation.read");if(context)return{tenantId:context.tenant.id,salonId:requestedSalonId(request)};});
  app.post("/test/write",async(request,reply)=>{const context=await requirePermission(request,reply,"reservation.write");if(context)return{allowed:true};});
  async function identity(name:string, verified=true) {
    const uid=`${prefix}-${name}`;const email=`${uid}@example.test`;
    identities.set(uid,{uid,email,email_verified:verified,name});
    const user=await prisma.appUser.create({data:{firebaseUid:uid,email,displayName:name}});userIds.push(user.id);
    return {...user,credential:uid};
  }
  try {
  const owner=await identity("owner");const limited=await identity("admin");const staff=await identity("staff");const outsider=await identity("outsider");const unverified=await identity("unverified",false);
  const tenant=await prisma.tenant.create({data:{slug:prefix,name:"Access test tenant"}});tenantIds.push(tenant.id);
  const other=await prisma.tenant.create({data:{slug:`${prefix}-other`,name:"Other test tenant"}});tenantIds.push(other.id);
  const salon=await prisma.salon.create({data:{tenantId:tenant.id,name:"A"}});
  const salon2=await prisma.salon.create({data:{tenantId:tenant.id,name:"B"}});
  const foreignSalon=await prisma.salon.create({data:{tenantId:other.id,name:"Foreign"}});
  await prisma.tenantMembership.createMany({data:[
    {tenantId:tenant.id,userId:owner.id,role:"OWNER"},
    {tenantId:tenant.id,userId:limited.id,role:"ADMIN",salonIds:[salon.id],useCustomPermissions:true,permissions:["access.manage","reservation.read","customer.read"]},
    {tenantId:tenant.id,userId:staff.id,role:"VIEWER",salonIds:[salon.id]},
    {tenantId:other.id,userId:outsider.id,role:"OWNER"}
  ]});
  const headers=(user:typeof owner,salonId?:string,slug=tenant.slug)=>({authorization:`Bearer ${user.credential}`,"x-tenant-slug":slug,...(salonId?{"x-salon-id":salonId}:{})});
  const assignment={role:"STAFF",status:"ACTIVE",useCustomPermissions:true,permissions:["reservation.read"],salonIds:[salon.id]};
  async function invite(user:typeof owner, target:typeof owner) {
    const {status,...input}=assignment;
    const response=await app.inject({method:"POST",url:"/api/access/invitations",headers:headers(user),payload:{...input,email:target.email}});
    assert.equal(response.statusCode,201,response.body);const body=response.json();
    assert.equal(body.acceptPath,undefined);
    const stored=await prisma.tenantInvitation.findUniqueOrThrow({where:{id:body.invitation.id}});
    return {id:stored.id,token:deriveInvitationToken(stored),body};
  }
  async function accept(user:typeof owner,token:string) {return app.inject({method:"POST",url:"/api/access/invitations/accept",headers:{authorization:`Bearer ${user.credential}`},payload:{token}});}

    await t.test("identity, tenant and salon guards prevent cross-boundary access",async()=>{
      assert.equal((await app.inject({url:"/api/access/members"})).statusCode,401);
      assert.equal((await app.inject({url:"/api/access/members",headers:headers(unverified)})).statusCode,403);
      assert.equal((await app.inject({url:"/api/access/members",headers:headers(owner,undefined,other.slug)})).statusCode,403);
      assert.equal((await app.inject({url:"/api/access/members",headers:headers(limited,salon2.id)})).statusCode,403);
      assert.equal((await app.inject({url:"/api/access/members",headers:headers(owner,foreignSalon.id)})).statusCode,403);
      const implicit=await app.inject({url:"/test/read",headers:headers(limited)});assert.equal(implicit.statusCode,200);assert.equal(implicit.json().salonId,salon.id);
      assert.equal((await app.inject({method:"POST",url:"/test/write",headers:headers(staff)})).statusCode,403);
      assert.equal((await app.inject({url:"/api/access/members",headers:headers(staff)})).statusCode,403);
    });
    await t.test("limited ADMIN lists only manageable users and cannot broaden or shrink foreign authority",async()=>{
      const list=await app.inject({url:"/api/access/members",headers:headers(limited)});assert.equal(list.statusCode,200);
      assert(!list.json().members.some((member:{userId:string})=>member.userId===owner.id));
      const patch=(id:string,payload:unknown)=>app.inject({method:"PATCH",url:`/api/access/members/${id}`,headers:headers(limited),payload});
      assert.equal((await patch(owner.id,assignment)).statusCode,403);
      assert.equal((await patch(staff.id,{...assignment,role:"OWNER"})).statusCode,403);
      assert.equal((await patch(staff.id,{...assignment,permissions:["checkout.refund"]})).statusCode,403);
      assert.equal((await patch(staff.id,{...assignment,salonIds:[]})).statusCode,403);
      assert.equal((await patch(staff.id,{...assignment,salonIds:[foreignSalon.id]})).statusCode,400);
      // Existing VIEWER includes more default read rights than this limited admin owns.
      assert.equal((await patch(staff.id,assignment)).statusCode,403);
      const unchanged=await prisma.tenantMembership.findUniqueOrThrow({where:{tenantId_userId:{tenantId:tenant.id,userId:staff.id}}});assert.equal(unchanged.role,"VIEWER");
      const changed=await app.inject({method:"PATCH",url:`/api/access/members/${staff.id}`,headers:headers(owner),payload:assignment});assert.equal(changed.statusCode,200);
      assert.equal((await patch(staff.id,{...assignment,status:"SUSPENDED"})).statusCode,200);
      assert.equal((await prisma.tenantMembership.findUniqueOrThrow({where:{tenantId_userId:{tenantId:tenant.id,userId:staff.id}}})).status,"SUSPENDED");
      assert.equal(await prisma.auditLog.count({where:{tenantId:tenant.id,action:"access.member.update",resourceId:staff.id}}),2);
    });
    await t.test("concurrent invite acceptance creates exactly one membership and audit event",async()=>{
      const target=await identity("concurrent");const created=await invite(owner,target);
      assert(!JSON.stringify(created.body.invitation).includes("tokenHash"));
      const stored=await prisma.tenantInvitation.findUniqueOrThrow({where:{id:created.id}});assert.notEqual(stored.tokenHash,created.token);assert.equal(stored.tokenHash.length,64);
      const outbox=await prisma.emailOutbox.findUniqueOrThrow({where:{eventKey:`invitation.created:${created.id}`}});
      assert.equal(outbox.eventType,"invitation.created");assert.equal(outbox.recipientEmail,target.email);
      assert(!JSON.stringify(outbox).includes(created.token));
      const responses=await Promise.all([accept(target,created.token),accept(target,created.token)]);
      assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,410]);
      assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,userId:target.id}}),1);
      assert.equal(await prisma.auditLog.count({where:{tenantId:tenant.id,action:"access.invitation.accept",resourceId:created.id}}),1);
      assert((await prisma.tenantInvitation.findUniqueOrThrow({where:{id:created.id}})).acceptedAt);
      const audits=await prisma.auditLog.findMany({where:{tenantId:tenant.id,resourceId:created.id}});assert(!JSON.stringify(audits).includes(created.token));
      assert.equal((await accept(target,created.token)).statusCode,410);
    });
    await t.test("wrong email, expiry, revocation and suspended inviter keep invitations unclaimed",async()=>{
      const target=await identity("expiry");const created=await invite(owner,target);
      assert.equal((await accept(outsider,created.token)).statusCode,403);
      await prisma.tenantInvitation.update({where:{id:created.id},data:{expiresAt:new Date(Date.now()-1000)}});
      assert.equal((await accept(target,created.token)).statusCode,410);
      assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,userId:target.id}}),0);
      const revoked=await invite(owner,target);
      assert.equal((await app.inject({method:"DELETE",url:`/api/access/invitations/${revoked.id}`,headers:headers(owner)})).statusCode,200);
      assert.equal((await accept(target,revoked.token)).statusCode,410);
      const invitedByAdmin=await invite(limited,target);
      await prisma.tenantMembership.update({where:{tenantId_userId:{tenantId:tenant.id,userId:limited.id}},data:{status:"SUSPENDED"}});
      assert.equal((await accept(target,invitedByAdmin.token)).statusCode,403);
      assert.equal((await prisma.tenantInvitation.findUniqueOrThrow({where:{id:invitedByAdmin.id}})).acceptedAt,null);
      assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,userId:target.id}}),0);
      assert((await prisma.tenantInvitation.findUniqueOrThrow({where:{id:revoked.id}})).revokedAt);
    });
    await t.test("invite acceptance rechecks recipient suspension and email after authentication",async()=>{
      for(const change of ["disabled","email"] as const){
        const target=await identity(`recipient-${change}`);const created=await invite(owner,target);
        let authenticated!:()=>void;const authenticatedGate=new Promise<void>((resolve)=>{authenticated=resolve;});
        let resume!:()=>void;const resumeGate=new Promise<void>((resolve)=>{resume=resolve;});
        const delayed=Fastify({logger:false});
        delayed.setErrorHandler((error,_request,reply)=>reply.code(error.statusCode??500).send({message:error.message}));
        registerAccessRoutes(delayed,{authenticate:async(request,reply)=>{
          const user=await requireAuthenticatedUser(request,reply);
          authenticated();await resumeGate;return user;
        }});
        try{
          const responsePromise=delayed.inject({method:"POST",url:"/api/access/invitations/accept",headers:{authorization:`Bearer ${target.credential}`},payload:{token:created.token}});
          await authenticatedGate;
          await prisma.appUser.update({where:{id:target.id},data:change==="disabled"?{disabled:true}:{email:`${prefix}-changed@example.test`}});
          resume();const response=await responsePromise;
          assert.equal(response.statusCode,403,response.body);
          assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,userId:target.id}}),0);
          assert.equal((await prisma.tenantInvitation.findUniqueOrThrow({where:{id:created.id}})).acceptedAt,null);
        }finally{resume();await delayed.close();}
      }
    });
    await t.test("a waiting mutation retries its stale snapshot and rejects a revoked membership", async()=>{
      const actor=await identity("operation-staff");
      const membership=await prisma.tenantMembership.create({data:{tenantId:tenant.id,userId:actor.id,role:"STAFF",useCustomPermissions:true,permissions:["checkout.write"],salonIds:[salon.id]}});
      const context={tenant,user:actor,membership,salon:{id:salon.id,name:salon.name,timezone:salon.timezone}};
      let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});
      let locked!:()=>void;const lockedGate=new Promise<void>((resolve)=>{locked=resolve;});
      let snapshotReady!:()=>void;const snapshotGate=new Promise<void>((resolve)=>{snapshotReady=resolve;});
      let attempts=0;
      const revocation=prisma.$transaction(async(tx)=>{
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenant.id} FOR UPDATE`;
        await tx.tenantMembership.update({where:{tenantId_userId:{tenantId:tenant.id,userId:actor.id}},data:{status:"SUSPENDED"}});
        locked();await gate;
      });
      await lockedGate;
      const write=runSerializable(async(tx)=>{
        attempts++;
        await tx.tenantMembership.findUnique({where:{tenantId_userId:{tenantId:tenant.id,userId:actor.id}}});
        if(attempts===1)snapshotReady();
        await lockOperation(tx,context,"checkout.write");
        await tx.auditLog.create({data:{tenantId:tenant.id,actorUserId:actor.id,action:"test.operation.applied",resource:"test"}});
      });
      const denied=assert.rejects(write,{statusCode:403});
      await snapshotGate;release();await revocation;await denied;
      assert(attempts>=2,"the stale Serializable snapshot must retry");
      assert.equal(await prisma.auditLog.count({where:{tenantId:tenant.id,action:"test.operation.applied",actorUserId:actor.id}}),0);

      const reset=async()=>prisma.tenantMembership.update({where:{tenantId_userId:{tenantId:tenant.id,userId:actor.id}},data:{status:"ACTIVE",permissions:["checkout.write"],salonIds:[salon.id]}});
      await reset();
      await prisma.tenantMembership.update({where:{tenantId_userId:{tenantId:tenant.id,userId:actor.id}},data:{permissions:[]}});
      await assert.rejects(runSerializable((tx)=>lockOperation(tx,context,"checkout.write")),{statusCode:403});
      await reset();
      await prisma.tenantMembership.update({where:{tenantId_userId:{tenantId:tenant.id,userId:actor.id}},data:{salonIds:[salon2.id]}});
      await assert.rejects(runSerializable((tx)=>lockOperation(tx,context,"checkout.write")),{statusCode:403});
      await reset();await prisma.appUser.update({where:{id:actor.id},data:{disabled:true}});
      await assert.rejects(runSerializable((tx)=>lockOperation(tx,context,"checkout.write")),{statusCode:403});
      await prisma.appUser.update({where:{id:actor.id},data:{disabled:false}});
      await runSerializable(async(tx)=>{
        await lockOperation(tx,context,"checkout.write");
        await tx.auditLog.create({data:{tenantId:tenant.id,actorUserId:actor.id,action:"test.operation.applied",resource:"test"}});
      });
      assert.equal(await prisma.auditLog.count({where:{tenantId:tenant.id,action:"test.operation.applied",actorUserId:actor.id}}),1);
    });
    await t.test("last owner cannot remove itself and competing owner changes preserve one owner",async()=>{
      assert.equal((await app.inject({method:"PATCH",url:`/api/access/members/${owner.id}`,headers:headers(owner),payload:assignment})).statusCode,403);
      assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,role:"OWNER",status:"ACTIVE"}}),1);
      const second=await identity("second-owner");await prisma.tenantMembership.create({data:{tenantId:tenant.id,userId:second.id,role:"OWNER"}});
      const responses=await Promise.all([
        app.inject({method:"PATCH",url:`/api/access/members/${second.id}`,headers:headers(owner),payload:assignment}),
        app.inject({method:"PATCH",url:`/api/access/members/${owner.id}`,headers:headers(second),payload:assignment})
      ]);
      assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,403]);
      assert.equal(await prisma.tenantMembership.count({where:{tenantId:tenant.id,role:"OWNER",status:"ACTIVE"}}),1);
    });
  } finally {
    await app.close();credentialMock.mock.restore();
    if(tenantIds.length)await prisma.emailOutbox.deleteMany({where:{tenantId:{in:tenantIds}}});
    for(const tenantId of tenantIds) await prisma.tenant.deleteMany({where:{id:tenantId}});
    if(userIds.length) await prisma.appUser.deleteMany({where:{id:{in:userIds}}});await prisma.$disconnect();
    if(previousInvitationTokenKey===undefined)delete process.env.INVITATION_TOKEN_KEY;
    else process.env.INVITATION_TOKEN_KEY=previousInvitationTokenKey;
  }
});
