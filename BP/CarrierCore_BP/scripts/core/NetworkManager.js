import { world, system } from "@minecraft/server";

export class NetworkManager {
  constructor() {
    this.carriers = new Map();
    this.towers = new Map();
    this.dataCenters = new Map();
    this.messages = [];
    this.ixps = new Map();
    this.sims = new Map();
    this.peers = new Map(); // carrierA_carrierB -> true
    this.services = new Map();
    this.routers = new Map();
    this.greenBoxes = new Map();
    this.dishes = new Map();
    this.receivers = new Map();
    this.contacts = new Map();
    this.microwaveLinks = new Map(); // id -> { aTowerId, bTowerId }
    this.peerLimits = new Map(); // "a_b" -> { textsPerDay, used, day }
    this.nextIds = { carrier: 1, tower: 1, message: 1, datacenter: 1, ixp: 1, sim: 1, service: 1, router: 1, greenbox: 1, dish: 1, receiver: 1, mw: 1 };
    this._particleTick = 0;
  }

  load() {
    try {
      const raw = world.getDynamicProperty("carriercore:network");
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        this.nextIds = data.nextIds || this.nextIds;
        if (data.carriers) this.carriers = new Map(data.carriers);
        if (data.towers) this.towers = new Map(data.towers);
        if (data.dataCenters) this.dataCenters = new Map(data.dataCenters);
        if (data.messages) this.messages = data.messages;
        if (data.sims) this.sims = new Map(data.sims);
        if (data.peers) this.peers = new Map(data.peers);
        if (data.ixps) this.ixps = new Map(data.ixps);
        if (data.services) this.services = new Map(data.services);
        if (data.routers) this.routers = new Map(data.routers);
        if (data.greenBoxes) this.greenBoxes = new Map(data.greenBoxes);
        if (data.dishes) this.dishes = new Map(data.dishes);
        if (data.receivers) this.receivers = new Map(data.receivers);
        if (data.contacts) this.contacts = new Map(data.contacts);
        if (data.microwaveLinks) this.microwaveLinks = new Map(data.microwaveLinks);
        if (data.peerLimits) this.peerLimits = new Map(data.peerLimits);
        console.log(`[CarrierCore] Loaded ${this.carriers.size} carriers, ${this.towers.size} towers, ${this.dataCenters.size} DCs`);
      }
    } catch (e) {
      console.warn("[CarrierCore] Load error:", e);
    }
  }

  save() {
    try {
      const data = {
        nextIds: this.nextIds,
        carriers: Array.from(this.carriers.entries()),
        towers: Array.from(this.towers.entries()),
        dataCenters: Array.from(this.dataCenters.entries()),
        messages: this.messages.slice(-30),
        sims: Array.from(this.sims.entries()),
        peers: Array.from(this.peers.entries()),
        ixps: Array.from(this.ixps.entries()),
        services: Array.from(this.services.entries()),
        routers: Array.from(this.routers.entries()),
        greenBoxes: Array.from(this.greenBoxes.entries()),
        dishes: Array.from(this.dishes.entries()),
        receivers: Array.from(this.receivers.entries()),
        contacts: Array.from(this.contacts.entries()),
        microwaveLinks: Array.from(this.microwaveLinks.entries()),
        peerLimits: Array.from(this.peerLimits.entries())
      };
      world.setDynamicProperty("carriercore:network", JSON.stringify(data));
    } catch (e) {
      console.warn("[CarrierCore] Save error:", e);
    }
  }

  tick() {
    try { this.processFinanceBridge(); } catch (e) {}

    this.processMessageQueue();
    this.updateLoads();
    this.refreshOutages();
    this._particleTick++;
    if (this._particleTick % 40 === 0) this.spawnStatusParticles();
  }

  refreshOutages() {
    // DC heat outage: mark DCs and dependent towers
    for (const dc of this.dataCenters.values()) {
      if (dc.heat > (dc.cooling || 40) + 20) {
        dc.throttled = true;
        dc.outage = "overheat";
      } else if (dc.heat > (dc.cooling || 40)) {
        dc.throttled = true;
        dc.outage = dc.outage === "overheat" ? "overheat" : "thermal";
      } else {
        dc.outage = null;
      }
    }
    for (const t of this.towers.values()) {
      if (t.maintenance) {
        t.online = false;
        t.outageReason = "maintenance";
        continue;
      }
      // re-check backhaul + DC health
      const hasDc = this.carrierHasDataCenter(t.carrierId);
      let dcOk = hasDc;
      for (const dc of this.dataCenters.values()) {
        if (dc.carrierId === t.carrierId && dc.outage === "overheat") {
          dcOk = false;
          break;
        }
      }
      // microwave can substitute for fiber backhaul
      const mw = this.towerHasMicrowaveBackhaul(t.id);
      if (!t.backhaul && !mw) {
        t.online = false;
        t.outageReason = "no_backhaul";
      } else if (!dcOk) {
        t.online = false;
        t.outageReason = "dc_outage";
      } else if (t.validated && t.power) {
        t.online = true;
        t.outageReason = null;
        if (mw && !t.backhaul) t.backhaulVia = "microwave";
      }
    }
    // routers offline if no green box path (refresh lightly)
    for (const r of this.routers.values()) {
      if (r.gbId) {
        const gb = this.greenBoxes.get(r.gbId);
        if (gb && !gb.online) r.uplink = false;
      }
    }
  }

  towerHasMicrowaveBackhaul(towerId, seen = null) {
    // Prevent cycles when chaining microwave hops
    if (!seen) seen = new Set();
    if (seen.has(towerId)) return false;
    seen.add(towerId);
    for (const link of this.microwaveLinks.values()) {
      if (link.aTowerId !== towerId && link.bTowerId !== towerId) continue;
      const otherId = link.aTowerId === towerId ? link.bTowerId : link.aTowerId;
      const other = this.towers.get(otherId);
      if (!other || other.maintenance) continue;
      // Hub has real fiber to DC
      if (other.backhaul) return true;
      // Or hub reaches fiber through another microwave hop
      if (this.towerHasMicrowaveBackhaul(otherId, seen)) return true;
    }
    return false;
  }

  spawnStatusParticles() {
    try {
      const dim = world.getDimension("minecraft:overworld");
      for (const t of this.towers.values()) {
        if (!t.online) continue;
        try {
          dim.spawnParticle("minecraft:villager_happy", { x: t.x + 0.5, y: t.y + 2.5, z: t.z + 0.5 });
        } catch {}
      }
      for (const r of this.routers.values()) {
        if (!r.uplink) continue;
        try {
          dim.spawnParticle("minecraft:endrod", { x: r.x + 0.5, y: r.y + 1.2, z: r.z + 0.5 });
        } catch {}
      }
    } catch {}
  }

  processMessageQueue() {
    const now = Date.now();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.status === "delivered" || msg.status === "failed") {
        if (now - (msg.createdAt || msg.deliveredAt || 0) > 180000) this.messages.splice(i, 1);
        continue;
      }
      // Routing stages: created -> uplink -> routing -> delivered
      msg.attempts = (msg.attempts || 0) + 1;
      if (msg.status === "created" || msg.status === "queued") {
        msg.status = "uplink";
      } else if (msg.status === "uplink") {
        // Cross-carrier requires peering
        if (msg.toCarrierId && msg.carrierId && msg.toCarrierId !== msg.carrierId) {
          if (!this.arePeers(msg.carrierId, msg.toCarrierId)) {
            msg.status = "failed";
            msg.failReason = "Carriers not peered";
            this.notifySender(msg, `§cMessage to ${msg.to} failed: carriers not peered.`);
            continue;
          }
        }
        msg.status = "routing";
      } else if (msg.status === "routing" || msg.attempts >= 3) {
        msg.status = "delivered";
        msg.deliveredAt = now;
        this.deliverToRecipient(msg);
      }
    }
    if (this.messages.length > 80) this.messages = this.messages.slice(-50);
  }

  arePeers(a, b) {
    if (a === b) return true;
    return this.peers.has(`${a}_${b}`) || this.peers.has(`${b}_${a}`);
  }

  findSimByNumber(number) {
    const n = String(number).replace(/\s/g, "");
    for (const s of this.sims.values()) {
      if (s.number === n || s.number.replace(/-/g, "") === n.replace(/-/g, "")) return s;
    }
    return null;
  }

  deliverToRecipient(msg) {
    let toSim = msg.toSimId ? this.sims.get(msg.toSimId) : null;
    if (!toSim) toSim = this.findSimByNumber(msg.to);
    const line = `§a[SMS] §fFrom ${msg.from}: §7${msg.content}`;
    let notified = false;
    if (toSim) {
      if (!toSim.inbox) toSim.inbox = [];
      if (!toSim.inbox.some(m => m.id === msg.id)) {
        toSim.inbox.push({ id: msg.id, from: msg.from, content: msg.content, at: Date.now(), read: false });
      }
    }
    try {
      for (const p of world.getAllPlayers()) {
        let notify = false;
        try {
          if (this.isAirplaneMode(p)) continue;
          const active = p.getDynamicProperty("carriercore:active_sim");
          const active2 = p.getDynamicProperty("carriercore:active_sim2");
          if (toSim && (active === toSim.id || active2 === toSim.id)) notify = true;
        } catch {}
        if (!notify && toSim && toSim.owner && p.name === toSim.owner) notify = true;
        if (!notify && toSim) {
          const owned = this.getPlayerSims(p.name);
          if (owned.some(s => s.id === toSim.id)) notify = true;
        }
        if (notify) {
          p.sendMessage(line);
          notified = true;
        }
      }
      if (!notified && toSim) {
        if (!toSim.voicemail) toSim.voicemail = [];
        if (!toSim.voicemail.some(m => m.id === msg.id)) {
          toSim.voicemail.push({ id: msg.id, from: msg.from, content: msg.content, at: Date.now(), read: false });
          if (toSim.voicemail.length > 30) toSim.voicemail = toSim.voicemail.slice(-25);
        }
        msg.voicemail = true;
        this.notifySender(msg, `§e[Receipt] §7Sent to voicemail for ${msg.to} (offline)`);
      } else {
        this.notifySender(msg, `§a[Receipt] §7Delivered to ${msg.to}`);
      }
    } catch (e) {
      console.warn("[CarrierCore] deliver error:", e);
    }
    this.save();
  }

  notifySender(msg, text) {
    try {
      const fromSim = this.findSimByNumber(msg.from);
      if (!fromSim) return;
      for (const p of world.getAllPlayers()) {
        if (fromSim.owner && p.name === fromSim.owner) p.sendMessage(text);
      }
    } catch {}
  }

  deregisterTowerAt(x, y, z, dimId = null) {
    let removed = null;
    for (const [id, t] of this.towers.entries()) {
      if (Math.abs(t.x - x) <= 2 && Math.abs(t.y - y) <= 3 && Math.abs(t.z - z) <= 2) {
        if (dimId && t.dim && t.dim !== dimId) continue;
        removed = t;
        this.towers.delete(id);
        const c = this.carriers.get(t.carrierId);
        if (c && c.towers) c.towers = c.towers.filter(tid => tid !== id);
        break;
      }
    }
    if (removed) this.save();
    return removed;
  }

  updateLoads() {
    for (const t of this.towers.values()) {
      if (t.load > 0) t.load = Math.max(0, t.load - 0.35);
    }
    for (const dc of this.dataCenters.values()) {
      if (dc.load > 0) dc.load = Math.max(0, dc.load - 0.5);
      // Simple cooling / power simulation
      if (dc.heat > dc.cooling) {
        dc.throttled = true;
        dc.heat = Math.max(0, dc.heat - 1);
      } else {
        dc.throttled = false;
        dc.heat = Math.max(0, dc.heat - 2);
      }
    }
  }

  // ----- Multi-block tower validation + real fiber path -----
  hasNearbyBlock(dimension, x, y, z, types, radius = 3, yMin = -2, yMax = 5) {
    const typeSet = Array.isArray(types) ? types : [types];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = yMin; dy <= yMax; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          try {
            const b = dimension.getBlock({ x: x + dx, y: y + dy, z: z + dz });
            if (b && typeSet.includes(b.typeId)) return true;
          } catch {}
        }
      }
    }
    return false;
  }

  /** Find first matching block in a vertical-ish volume; returns {x,y,z} or null */
  findNearbyBlock(dimension, x, y, z, types, radius = 3, yMin = -2, yMax = 8) {
    const typeSet = Array.isArray(types) ? types : [types];
    for (let dy = yMin; dy <= yMax; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          try {
            const bx = x + dx, by = y + dy, bz = z + dz;
            const b = dimension.getBlock({ x: bx, y: by, z: bz });
            if (b && typeSet.includes(b.typeId)) return { x: bx, y: by, z: bz };
          } catch {}
        }
      }
    }
    return null;
  }

  /**
   * Antenna on a tall mast: must be fiber-path-connected to BBU (server rack).
   * Allows up to maxHeight vertical separation (default 100).
   */
  isAntennaFiberWiredToBbu(dimension, bbu, maxHeight = 100, maxSteps = 120) {
    if (!bbu) return { ok: false, reason: "no_bbu" };
    // BFS along fiber from BBU, look for antenna adjacent to any fiber node or antenna itself on path
    const key = (x, y, z) => `${x},${y},${z}`;
    const visited = new Set();
    const queue = [];
    // Seed from fiber next to BBU
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          try {
            const bx = bbu.x + dx, by = bbu.y + dy, bz = bbu.z + dz;
            const b = dimension.getBlock({ x: bx, y: by, z: bz });
            if (b && this.isFiberBlock(b.typeId)) {
              const k = key(bx, by, bz);
              if (!visited.has(k)) {
                visited.add(k);
                queue.push({ x: bx, y: by, z: bz, steps: 0 });
              }
            }
            if (b && b.typeId === "carriercore:antenna") {
              // Antenna directly adjacent to BBU (short tower)
              return { ok: true, reason: "adjacent", height: Math.abs(by - bbu.y), steps: 0 };
            }
          } catch {}
        }
      }
    }
    if (queue.length === 0) {
      // Also allow pure vertical scan: antenna above BBU within radius 2 horizontally
      for (let dy = 1; dy <= maxHeight; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            try {
              const b = dimension.getBlock({ x: bbu.x + dx, y: bbu.y + dy, z: bbu.z + dz });
              if (b && b.typeId === "carriercore:antenna") {
                // Require continuous fiber column OR accept if fiber exists along most of the path
                return { ok: false, reason: "antenna_found_but_no_fiber_feed", height: dy };
              }
            } catch {}
          }
        }
      }
      return { ok: false, reason: "no_fiber_at_bbu" };
    }
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    let head = 0;
    let bestAntenna = null;
    while (head < queue.length && head < maxSteps) {
      const cur = queue[head++];
      // Antenna next to this fiber segment
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            try {
              const ax = cur.x + dx, ay = cur.y + dy, az = cur.z + dz;
              const ab = dimension.getBlock({ x: ax, y: ay, z: az });
              if (ab && ab.typeId === "carriercore:antenna") {
                const height = Math.abs(ay - bbu.y);
                if (height <= maxHeight) {
                  return { ok: true, reason: "fiber_feed", height, steps: cur.steps, antenna: { x: ax, y: ay, z: az } };
                }
              }
            } catch {}
          }
        }
      }
      if (cur.steps >= maxSteps) continue;
      for (const [dx, dy, dz] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
        // Bound search to tower column roughly
        if (Math.abs(nx - bbu.x) > 8 || Math.abs(nz - bbu.z) > 8) continue;
        if (ny < bbu.y - 5 || ny > bbu.y + maxHeight + 2) continue;
        const k = key(nx, ny, nz);
        if (visited.has(k)) continue;
        try {
          const b = dimension.getBlock({ x: nx, y: ny, z: nz });
          if (b && this.isFiberBlock(b.typeId)) {
            visited.add(k);
            queue.push({ x: nx, y: ny, z: nz, steps: cur.steps + 1 });
          }
        } catch {}
      }
    }
    return { ok: false, reason: "no_antenna_on_feed", steps: visited.size };
  }

  isFiberBlock(typeId) {
    return typeId === "carriercore:fiber_cable";
  }

  carrierHasDataCenter(carrierId) {
    for (const dc of this.dataCenters.values()) {
      if (dc.carrierId === carrierId) return true;
    }
    return false;
  }

  getCarrierDataCenters(carrierId) {
    const list = [];
    for (const dc of this.dataCenters.values()) {
      if (dc.carrierId === carrierId) list.push(dc);
    }
    return list;
  }

  /**
   * BFS along connected fiber blocks from the tower site.
   * Returns true if any fiber in the path is within reach of a data center.
   * Limited steps for performance.
   */
  hasFiberPathToDataCenter(dimension, startX, startY, startZ, carrierId, maxSteps = 150) {
    const dcs = this.getCarrierDataCenters(carrierId);
    if (dcs.length === 0) return { connected: false, reason: "no_dc", steps: 0 };

    const dcReach = 4; // fiber must come within this many blocks of a DC
    const nearDc = (x, y, z) => {
      for (const dc of dcs) {
        if (dc.dim && dc.dim !== dimension.id) continue;
        const dx = x - dc.x, dy = y - dc.y, dz = z - dc.z;
        if (Math.abs(dx) <= dcReach && Math.abs(dy) <= dcReach && Math.abs(dz) <= dcReach) {
          return true;
        }
      }
      return false;
    };

    // Seed queue with all fiber blocks near the tower site
    const key = (x, y, z) => `${x},${y},${z}`;
    const visited = new Set();
    const queue = [];

    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -2; dy <= 5; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          const x = startX + dx, y = startY + dy, z = startZ + dz;
          try {
            const b = dimension.getBlock({ x, y, z });
            if (b && this.isFiberBlock(b.typeId)) {
              const k = key(x, y, z);
              if (!visited.has(k)) {
                visited.add(k);
                queue.push({ x, y, z, steps: 0 });
              }
            }
          } catch {}
        }
      }
    }

    if (queue.length === 0) {
      return { connected: false, reason: "no_fiber_at_site", steps: 0 };
    }

    const dirs = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1]
    ];

    let head = 0;
    while (head < queue.length && head < maxSteps) {
      const cur = queue[head++];
      if (nearDc(cur.x, cur.y, cur.z)) {
        return { connected: true, reason: "path_ok", steps: cur.steps };
      }
      if (cur.steps >= maxSteps) continue;
      for (const [dx, dy, dz] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
        const k = key(nx, ny, nz);
        if (visited.has(k)) continue;
        try {
          const b = dimension.getBlock({ x: nx, y: ny, z: nz });
          if (b && this.isFiberBlock(b.typeId)) {
            visited.add(k);
            queue.push({ x: nx, y: ny, z: nz, steps: cur.steps + 1 });
          }
        } catch {}
      }
    }

    return { connected: false, reason: "no_path", steps: visited.size };
  }

  validateTowerStructure(dimension, x, y, z, carrierId = null) {
    // Player stands at base / shelter: BBU, power, cooling near feet
    const base = this.hasNearbyBlock(dimension, x, y, z, "carriercore:tower_base", 3, -2, 6);
    const power = this.hasNearbyBlock(dimension, x, y, z, "carriercore:power_unit", 4, -2, 6);
    const cooling = this.hasNearbyBlock(dimension, x, y, z, "carriercore:cooling_unit", 4, -2, 6);
    const fiberAtSite = this.hasNearbyBlock(dimension, x, y, z, "carriercore:fiber_cable", 4, -2, 8);
    const bbuPos = this.findNearbyBlock(dimension, x, y, z, "carriercore:server_rack", 4, -2, 8);
    const server = !!bbuPos;

    // Tall tower: antenna up to 100 blocks above, fed by fiber from BBU
    let feed = { ok: false, reason: "no_bbu" };
    if (bbuPos) {
      feed = this.isAntennaFiberWiredToBbu(dimension, bbuPos, 100, 130);
    }
    // Fallback short towers: antenna within 6 of registration point
    const antennaNear = this.hasNearbyBlock(dimension, x, y, z, "carriercore:antenna", 3, -2, 8);
    const antennaWiredToBbu = feed.ok || (antennaNear && server && this.hasNearbyBlock(dimension, x, y, z, "carriercore:antenna", 4, -2, 12));

    const hasDc = carrierId ? this.carrierHasDataCenter(carrierId) : false;
    let pathResult = { connected: false, reason: "skipped", steps: 0 };
    if (fiberAtSite && hasDc && carrierId) {
      pathResult = this.hasFiberPathToDataCenter(dimension, x, y, z, carrierId, 150);
    }

    const hasBackhaul = pathResult.connected === true;
    // Site valid for registration: base + BBU + antenna feed + power + cooling
    const valid = base && server && antennaWiredToBbu && power && cooling;

    return {
      valid,
      antennaWiredToBbu,
      hasPower: power,
      hasCooling: cooling,
      hasFiber: fiberAtSite,
      hasServer: server,
      hasDataCenter: hasDc,
      hasBackhaul,
      pathReason: pathResult.reason,
      pathSteps: pathResult.steps,
      feedReason: feed.reason,
      antennaHeight: feed.height || 0,
      base,
      antenna: antennaWiredToBbu,
      power,
      cooling,
      fiber: fiberAtSite,
      server
    };
  }

  getObstaclePenalty(dimension, from, to) {
    let penalty = 0;
    const steps = 6;
    const dx = (to.x - from.x) / steps;
    const dy = (to.y - from.y) / steps;
    const dz = (to.z - from.z) / steps;
    for (let i = 1; i < steps; i++) {
      try {
        const bx = Math.floor(from.x + dx * i);
        const by = Math.floor(from.y + dy * i);
        const bz = Math.floor(from.z + dz * i);
        const block = dimension.getBlock({ x: bx, y: by, z: bz });
        if (!block || block.typeId === "minecraft:air") continue;
        const id = block.typeId;
        if (id.includes("iron") || id.includes("copper") || id.includes("gold") || id.includes("deepslate")) {
          penalty += 0.18;
        } else if (id.includes("stone") || id.includes("cobble") || id.includes("brick")) {
          penalty += 0.10;
        } else if (!id.includes("glass") && !id.includes("leaves")) {
          penalty += 0.05;
        }
      } catch {}
    }
    return Math.min(0.7, penalty);
  }

  getBestSignal(player, carrierId = null) {
    const loc = player.location;
    const dim = player.dimension;
    let best = null;
    let bestScore = -1;

    for (const t of this.towers.values()) {
      if (!t.online || !t.power || t.maintenance) continue;
      if (carrierId && t.carrierId !== carrierId) {
        if (!this.arePeered(carrierId, t.carrierId)) continue;
        // roaming deal limits checked at send time
      }

      const dx = loc.x - t.x;
      const dy = loc.y - t.y;
      const dz = loc.z - t.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > t.range) continue;

      const obstacle = this.getObstaclePenalty(dim, loc, { x: t.x, y: t.y + 2, z: t.z });
      const techMult = { "2G": 1.0, "3G": 1.35, "4G": 1.7, "5G": 2.2, "5G+": 2.6 }[t.tech] || 1.4;
      const loadFactor = Math.max(0.15, 1 - (t.load / Math.max(1, t.capacity)));
      const score = (1 - dist / t.range) * techMult * loadFactor * (1 - obstacle);

      if (score > bestScore) {
        bestScore = score;
        best = {
          tower: t,
          dist: Math.round(dist),
          score,
          bars: Math.max(1, Math.min(4, Math.ceil(score * 3.5))),
          tech: t.tech,
          obstacle: Math.round(obstacle * 100),
          roaming: !!(carrierId && t.carrierId !== carrierId),
          towerCarrierId: t.carrierId
        };
      }
    }
    return best;
  }

  createCarrier(name, color = "§9") {
    const id = `c${this.nextIds.carrier++}`;
    const carrier = {
      id,
      name: name || `Carrier-${id}`,
      color,
      plans: [
        { id: "basic", name: "Basic", texts: 50, dataMB: 100 },
        { id: "plus", name: "Plus", texts: 200, dataMB: 500 },
        { id: "unl", name: "Unlimited", texts: 9999, dataMB: 9999 }
      ],
      towers: [],
      dataCenters: [],
      peers: [],
      areaCode: String(200 + (this.nextIds.carrier * 53) % 800).padStart(3, "0")
    };
    this.carriers.set(id, carrier);
    this.save();
    return carrier;
  }

  registerTower(player, carrierId, config = {}) {
    const loc = player.location;
    const validation = this.validateTowerStructure(
      player.dimension,
      Math.floor(loc.x),
      Math.floor(loc.y),
      Math.floor(loc.z),
      carrierId
    );
    const powerOk = validation.hasPower || validation.base;
    // Site: base + BBU + antenna feed (fiber up the mast) + power + cooling.
    // Long-haul fiber to DC is optional (microwave hub allowed).
    if (!validation.antennaWiredToBbu || !validation.hasPower || !validation.hasCooling || !validation.base || !validation.hasServer) {
      return { tower: null, validation, rejected: true, reason: "site" };
    }
    const tech = config.tech || "4G";
    const techRange = { "2G": 40, "3G": 48, "4G": 56, "5G": 64, "5G+": 72 };
    const id = `t${this.nextIds.tower++}`;
    const fiberOk = !!validation.hasBackhaul;
    // Check existing microwave links (if re-registering near linked site)
    let mwOk = false;
    const tower = {
      id,
      carrierId,
      x: Math.floor(loc.x),
      y: Math.floor(loc.y),
      z: Math.floor(loc.z),
      dim: player.dimension.id,
      range: config.range || techRange[tech] || 56,
      capacity: config.capacity || ({ "2G": 8, "3G": 12, "4G": 18, "5G": 28, "5G+": 40 }[tech] || 18),
      tech,
      load: 0,
      online: false,
      power: true,
      backhaul: fiberOk,
      backhaulVia: fiberOk ? "fiber" : null,
      validated: true,
      hasFiber: !!validation.hasFiber,
      hasServer: !!validation.hasServer,
      antennaWired: true,
      pendingBackhaul: !fiberOk
    };
    this.towers.set(id, tower);
    mwOk = this.towerHasMicrowaveBackhaul(id);
    if (fiberOk || mwOk) {
      tower.online = true;
      tower.pendingBackhaul = false;
      if (mwOk && !fiberOk) tower.backhaulVia = "microwave";
    }
    const c = this.carriers.get(carrierId);
    if (c) c.towers.push(id);
    this.save();
    return { tower, validation, rejected: false, pendingBackhaul: tower.pendingBackhaul };
  }

  registerDataCenter(player, carrierId) {
    const id = `dc${this.nextIds.datacenter++}`;
    const dc = {
      id,
      carrierId,
      x: Math.floor(player.location.x),
      y: Math.floor(player.location.y),
      z: Math.floor(player.location.z),
      dim: player.dimension.id,
      load: 0,
      capacity: 100,
      heat: 0,
      cooling: 40,
      power: 50,
      throttled: false,
      servers: 1
    };
    this.dataCenters.set(id, dc);
    const c = this.carriers.get(carrierId);
    if (c) c.dataCenters.push(id);
    // Re-check towers: fiber+DC now available for backhaul
    this.refreshCarrierTowers(carrierId);
    this.save();
    return dc;
  }

  refreshCarrierTowers(carrierId) {
    let dim = null;
    try {
      dim = world.getDimension("minecraft:overworld");
    } catch {}
    for (const t of this.towers.values()) {
      if (t.carrierId !== carrierId) continue;
      const hasDc = this.carrierHasDataCenter(carrierId);
      if (dim && hasDc) {
        const path = this.hasFiberPathToDataCenter(dim, t.x, t.y, t.z, carrierId);
        t.backhaul = path.connected;
        if (t.backhaul) t.backhaulVia = "fiber";
      } else {
        t.backhaul = false;
      }
      const mw = this.towerHasMicrowaveBackhaul(t.id);
      if (t.maintenance) {
        t.online = false;
        t.outageReason = "maintenance";
      } else if ((t.backhaul || mw) && t.validated && t.power && hasDc) {
        t.online = true;
        t.pendingBackhaul = false;
        t.outageReason = null;
        if (mw && !t.backhaul) t.backhaulVia = "microwave";
      } else {
        t.online = false;
        t.pendingBackhaul = !t.backhaul && !mw;
        t.outageReason = t.pendingBackhaul ? "no_backhaul" : "offline";
      }
    }
  }

  createIXP(player, name = "IXP") {
    const id = `ixp${this.nextIds.ixp++}`;
    const ixp = {
      id,
      name,
      x: Math.floor(player.location.x),
      y: Math.floor(player.location.y),
      z: Math.floor(player.location.z),
      members: []
    };
    this.ixps.set(id, ixp);
    this.save();
    return ixp;
  }

  addPeer(carrierA, carrierB) {
    if (carrierA === carrierB) return false;
    const key1 = `${carrierA}_${carrierB}`;
    const key2 = `${carrierB}_${carrierA}`;
    this.peers.set(key1, true);
    this.peers.set(key2, true);
    const a = this.carriers.get(carrierA);
    const b = this.carriers.get(carrierB);
    if (a && !a.peers.includes(carrierB)) a.peers.push(carrierB);
    if (b && !b.peers.includes(carrierA)) b.peers.push(carrierA);
    this.save();
    return true;
  }

  arePeered(a, b) {
    return this.arePeers(a, b);
  }

  createSim(carrierId, planId = "basic", ownerName = null) {
    const carrier = this.carriers.get(carrierId);
    if (!carrier) return null;
    const id = `s${this.nextIds.sim++}`;
    // Dynamic numbers: carrier area code + exchange + line
    if (!carrier.areaCode) {
      carrier.areaCode = String(200 + (this.nextIds.carrier * 17 + id.length * 3) % 800).padStart(3, "0");
    }
    const exchange = String(200 + (this.nextIds.sim * 37) % 800).padStart(3, "0");
    const line = String(1000 + (this.nextIds.sim * 91) % 9000).slice(-4);
    const number = `${carrier.areaCode}-${exchange}-${line}`;
    const plan = carrier.plans.find(p => p.id === planId) || carrier.plans[0];
    const sim = {
      id, carrierId, number, planId: plan.id,
      textsLeft: plan.texts, dataLeftMB: plan.dataMB,
      textsUsed: 0, dataUsedMB: 0, lastTopUp: Date.now(),
      owner: ownerName,
      inbox: [], voicemail: []
    };
    this.sims.set(id, sim);
    this.save();
    return sim;
  }

  getPlayerSims(playerName) {
    const list = [];
    for (const s of this.sims.values()) {
      if (!s.owner || s.owner === playerName) list.push(s);
    }
    return list;
  }

  getActiveSim(player) {
    try {
      const activeId = player.getDynamicProperty("carriercore:active_sim");
      if (activeId && activeId !== "" && this.sims.has(activeId)) return this.sims.get(activeId);
    } catch {}
    return null;
  }

  setActiveSim(player, simId) {
    if (!this.sims.has(simId)) return false;
    try {
      player.setDynamicProperty("carriercore:active_sim", simId);
    } catch {}
    return true;
  }

  ejectSim(player) {
    try {
      player.setDynamicProperty("carriercore:active_sim", "");
    } catch {}
    return true;
  }

  sendText(fromSimId, toNumber, content) {
    const from = this.sims.get(fromSimId);
    if (!from) return { ok: false, reason: "Invalid SIM" };
    if (from.textsLeft <= 0) return { ok: false, reason: "Text quota exceeded – upgrade plan or top up" };
    const toSim = this.findSimByNumber(toNumber);
    const toCarrierId = toSim ? toSim.carrierId : null;
    if (toCarrierId && toCarrierId !== from.carrierId) {
      if (!this.arePeers(from.carrierId, toCarrierId)) {
        return { ok: false, reason: "Destination carrier not peered – message blocked" };
      }
      const lim = this.checkPeerTextLimit(from.carrierId, toCarrierId);
      if (!lim.ok) return { ok: false, reason: lim.reason };
    }
    const msg = {
      id: `m${this.nextIds.message++}`,
      from: from.number,
      to: toSim ? toSim.number : String(toNumber),
      content: String(content).substring(0, 200),
      status: "created",
      createdAt: Date.now(),
      attempts: 0,
      carrierId: from.carrierId,
      toCarrierId,
      toSimId: toSim ? toSim.id : null
    };
    this.messages.push(msg);
    from.textsLeft = Math.max(0, from.textsLeft - 1);
    from.textsUsed = (from.textsUsed || 0) + 1;
    if (toSim) {
      if (!toSim.inbox) toSim.inbox = [];
      toSim.inbox.push({
        id: msg.id,
        from: msg.from,
        content: msg.content,
        at: msg.createdAt,
        read: false
      });
      if (toSim.inbox.length > 40) toSim.inbox = toSim.inbox.slice(-30);
    }
    for (const dc of this.dataCenters.values()) {
      if (dc.carrierId === from.carrierId) {
        dc.load = Math.min(dc.capacity, dc.load + 3);
        dc.heat += 2;
        break;
      }
    }
    this.save();
    return { ok: true, message: msg, toSim };
  }

  // ----- Internet services (hosted sites) -----
  // Types: weather | news | sports | carrier | custom
  createService(hostCarrierId, name, path = "/", type = "custom") {
    const carrier = this.carriers.get(hostCarrierId);
    if (!carrier) return null;
    const id = `svc${this.nextIds.service++}`;
    const costs = { weather: 1, news: 2, sports: 2, carrier: 1, custom: 2 };
    const service = {
      id,
      name: name || `Service-${id}`,
      hostCarrierId,
      path: path || "/",
      type: type || "custom",
      dataCostMB: costs[type] || 2
    };
    this.services.set(id, service);
    this.save();
    return service;
  }

  getInGameWeather(player) {
    // Reflects live Minecraft weather when the API is available
    let weather = "Clear";
    let detail = "Skies are clear.";
    try {
      const dim = player.dimension;
      if (typeof dim.getWeather === "function") {
        const w = dim.getWeather();
        const s = String(w);
        if (s.includes("Thunder") || s.includes("thunder")) {
          weather = "Thunder";
          detail = "Thunderstorm in progress. Heavy rain and lightning.";
        } else if (s.includes("Rain") || s.includes("rain")) {
          weather = "Rain";
          detail = "It is raining across the region.";
        } else {
          weather = "Clear";
          detail = "Fair weather. No precipitation.";
        }
      }
    } catch {}
    let timeLabel = "Day";
    try {
      const t = world.getTimeOfDay ? world.getTimeOfDay() : (world.getAbsoluteTime() % 24000);
      const tod = typeof t === "number" ? t : 0;
      if (tod >= 0 && tod < 1000) timeLabel = "Sunrise";
      else if (tod < 11000) timeLabel = "Day";
      else if (tod < 13000) timeLabel = "Sunset";
      else if (tod < 23000) timeLabel = "Night";
      else timeLabel = "Sunrise";
    } catch {}
    return { weather, detail, timeLabel };
  }

  buildPage(svc, player, sim, host) {
    const header = `§b=== ${svc.name} ===\n§7Host: ${host ? host.name : "?"} · ${svc.path}\n`;
    const footer = `\n§8Data used: ${svc.dataCostMB} MB · Left: ${sim.dataLeftMB} MB`;

    if (svc.type === "weather") {
      const w = this.getInGameWeather(player);
      const icon = w.weather === "Thunder" ? "§c⚡" : w.weather === "Rain" ? "§9🌧" : "§e☀";
      return header +
        `§fLIVE Weather Report\n` +
        `${icon} §fConditions: §l${w.weather}\n` +
        `§7Time of day: §f${w.timeLabel}\n` +
        `§7${w.detail}\n` +
        `§8Updated from local sensors (in-game weather)` + footer;
    }

    if (svc.type === "news") {
      const w = this.getInGameWeather(player);
      const headlines = [
        `§f• Local tower upgrades roll out ${w.weather === "Clear" ? "under clear skies" : "despite " + w.weather.toLowerCase()}`,
        `§f• Carrier ${host ? host.name : "Network"} expands coverage this week`,
        `§f• Text messaging volume up ${10 + (this.messages.length % 40)}% region-wide`,
        `§f• Engineers advise fiber checks after ${w.weather === "Thunder" ? "storms" : "maintenance windows"}`,
        `§f• New 5G+ sites pending registration in outlying areas`
      ];
      // rotate by time
      let seed = 0;
      try { seed = world.getAbsoluteTime() % headlines.length; } catch { seed = this.messages.length % headlines.length; }
      const ordered = headlines.slice(seed).concat(headlines.slice(0, seed));
      return header + `§l§fTop Stories\n` + ordered.slice(0, 4).join("\n") + footer;
    }

    if (svc.type === "sports") {
      const a = 1 + (this.nextIds.message % 5);
      const b = 1 + (this.towers.size % 4);
      return header +
        `§l§fSports Wire\n` +
        `§f• Block Racers: Team Red ${a} – Team Blue ${b}\n` +
        `§f• Mining League: overtime in the deep dark\n` +
        `§f• Elytra Cup qualifiers open this weekend\n` +
        `§7Scores simulated for your world` + footer;
    }

    if (svc.type === "carrier") {
      const towers = [...this.towers.values()].filter(t => t.carrierId === svc.hostCarrierId);
      const online = towers.filter(t => t.online).length;
      return header +
        `§l§f${host ? host.name : "Carrier"} Portal\n` +
        `§7Towers online: §f${online}/${towers.length}\n` +
        `§7Your number plans: Basic · Plus · Unlimited\n` +
        `§7Support: visit a Network Terminal in-game\n` +
        `§fThank you for choosing ${host ? host.name : "us"}.` + footer;
    }

    // custom
    return header + `§fWelcome to ${svc.name}.\n§7A hosted service on this carrier's network.` + footer;
  }

  browseService(player, simId, serviceId) {
    const sim = this.sims.get(simId);
    const svc = this.services.get(serviceId);
    if (!sim) return { ok: false, reason: "No SIM" };
    if (!svc) return { ok: false, reason: "Unknown site" };
    if (sim.dataLeftMB < svc.dataCostMB) return { ok: false, reason: "Not enough data" };
    const path = this.getDataPath(player, sim);
    if (path.mode === "none") return { ok: false, reason: "No signal (cell or WiFi)" };
    if (svc.hostCarrierId !== sim.carrierId && !this.arePeers(sim.carrierId, svc.hostCarrierId)) {
      return { ok: false, reason: "Host carrier not peered – no route" };
    }
    const signal = path.signal;
    let cost = svc.dataCostMB;
    if (this.hasNearbyCdn(player)) cost = Math.max(1, Math.ceil(cost * 0.5));
    // captive portal on public WiFi
    if (path.mode === "wifi" && path.wifi) {
      const ap = path.wifi.type === "router" ? this.routers.get(path.wifi.id) : null;
      if (ap && ap.public && !player.getDynamicProperty("carriercore:captive_ok_" + ap.id)) {
        return { ok: false, reason: "CAPTIVE", captive: true, ssid: ap.ssid, apId: ap.id };
      }
    }
    sim.dataLeftMB = Math.max(0, sim.dataLeftMB - cost);
    sim.dataUsedMB = (sim.dataUsedMB || 0) + cost;
    if (signal && signal.tower) signal.tower.load = Math.min(signal.tower.capacity, (signal.tower.load || 0) + 2);
    for (const dc of this.dataCenters.values()) {
      if (dc.carrierId === svc.hostCarrierId) {
        dc.load = Math.min(dc.capacity, dc.load + 4);
        dc.heat += 1;
        break;
      }
    }
    this.save();
    const host = this.getCarrier(svc.hostCarrierId);
    return { ok: true, page: this.buildPage(svc, player, sim, host) };
  }

  getCarrier(id) { return this.carriers.get(id); }

  // ----- Contacts / top-up / speed -----
  getContacts(playerName) {
    if (!this.contacts.has(playerName)) this.contacts.set(playerName, []);
    return this.contacts.get(playerName);
  }

  addContact(playerName, name, number) {
    const list = this.getContacts(playerName);
    if (list.some(c => c.number === number)) return false;
    list.push({ name: name || number, number });
    if (list.length > 40) list.shift();
    this.save();
    return true;
  }


  // ---------- FinanceCore bridge (phone browser payments) ----------
  isFinanceCorePresent() {
    try {
      const raw = world.getDynamicProperty("financecore:state");
      return !!(raw && typeof raw === "string");
    } catch (e) {
      return false;
    }
  }

  _loadFinanceState() {
    try {
      const raw = world.getDynamicProperty("financecore:state");
      if (!raw || typeof raw !== "string") return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  _saveFinanceState(data) {
    try {
      world.setDynamicProperty("financecore:state", JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  _luhnValid(pan) {
    const digits = String(pan || "").replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /**
   * Charge a FinanceCore embossed card by PAN (Luhn + CVV + expiry).
   * Mutates financecore:state in the world.
   */
  chargeFinanceCard(pan, expiry, cvv, amount, merchant) {
    amount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "Invalid amount" };
    if (!this._luhnValid(pan)) return { ok: false, reason: "Invalid card number" };
    const data = this._loadFinanceState();
    if (!data) return { ok: false, reason: "FinanceCore not loaded — enable FinanceCore BP in this world" };

    const cards = data.cards ? (Array.isArray(data.cards) ? data.cards : Object.entries(data.cards || {})) : [];
    const digits = String(pan).replace(/\D/g, "");
    let card = null;
    let cardKey = null;
    for (const entry of cards) {
      const c = Array.isArray(entry) ? entry[1] : entry;
      const k = Array.isArray(entry) ? entry[0] : (c && c.id);
      if (!c) continue;
      if (c.pan && String(c.pan).replace(/\D/g, "") === digits) {
        card = c;
        cardKey = k;
        break;
      }
    }
    if (!card) return { ok: false, reason: "Card not on file in FinanceCore" };
    if (card.status && card.status !== "active") return { ok: false, reason: "Card " + card.status };
    if (cvv != null && String(cvv).trim() !== "" && String(card.cvv) !== String(cvv).trim()) {
      return { ok: false, reason: "CVV incorrect" };
    }
    if (expiry) {
      const a = String(expiry).replace(/\D/g, "");
      const b = String(card.expiry || "").replace(/\D/g, "");
      if (a && b && a !== b) return { ok: false, reason: "Expiry mismatch" };
    }

    const accounts = data.accounts
      ? Array.isArray(data.accounts)
        ? data.accounts
        : Object.entries(data.accounts || {})
      : [];
    let acc = null;
    let accKey = null;
    for (const entry of accounts) {
      const a = Array.isArray(entry) ? entry[1] : entry;
      const k = Array.isArray(entry) ? entry[0] : (a && a.id);
      if (a && a.id === card.accountId) {
        acc = a;
        accKey = k;
        break;
      }
    }
    if (!acc) return { ok: false, reason: "Linked account missing" };

    if (acc.type === "credit") {
      if (acc.overdue) return { ok: false, reason: "Card overdue" };
      const limit = acc.limit || 0;
      if ((acc.balance || 0) + amount > limit) return { ok: false, reason: "Over credit limit" };
      acc.balance = Math.round(((acc.balance || 0) + amount) * 100) / 100;
    } else {
      if ((acc.balance || 0) < amount) return { ok: false, reason: "Insufficient funds" };
      acc.balance = Math.round(((acc.balance || 0) - amount) * 100) / 100;
    }
    if (!acc.ledger) acc.ledger = [];
    acc.ledger.push({
      type: "phone_browser",
      amount,
      merchant: String(merchant || "Phone browser").slice(0, 40),
      panLast4: card.last4,
      at: Date.now()
    });
    if (acc.ledger.length > 40) acc.ledger = acc.ledger.slice(-40);

    // write back maps
    if (Array.isArray(data.accounts)) {
      data.accounts = accounts.map((e) => (Array.isArray(e) ? e : [e.id, e]));
    } else if (accKey != null) {
      data.accounts = Object.fromEntries(accounts.map((e) => (Array.isArray(e) ? e : [e.id, e])));
    }
    // Prefer array-of-entries form used by FinanceCore
    data.accounts = accounts.map((e) => {
      if (Array.isArray(e)) return e[1].id === acc.id ? [e[0], acc] : e;
      return e.id === acc.id ? [e.id, acc] : [e.id, e];
    });
    data.cards = cards.map((e) => (Array.isArray(e) ? e : [e.id, e]));

    if (!this._saveFinanceState(data)) return { ok: false, reason: "Could not save FinanceCore state" };
    return {
      ok: true,
      last4: card.last4,
      balance: acc.balance,
      amount
    };
  }

  /** Carrier store plans purchasable from phone browser */
  getBrowserPlans() {
    return [
      { id: "basic", name: "Basic", price: 25, texts: 200, dataMB: 2048 },
      { id: "plus", name: "Plus", price: 45, texts: 500, dataMB: 10240 },
      { id: "unlimited", name: "Unlimited", price: 75, texts: 9999, dataMB: 51200 },
      { id: "data_heavy", name: "Data Heavy", price: 65, texts: 100, dataMB: 40960 }
    ];
  }

  applyPaidPlanToSim(simId, plan) {
    const sim = this.sims.get(simId);
    if (!sim) return { ok: false, reason: "SIM not found" };
    sim.planId = plan.id;
    sim.planName = plan.name;
    sim.textsLeft = (sim.textsLeft || 0) + (plan.texts || 0);
    sim.dataLeftMB = (sim.dataLeftMB || 0) + (plan.dataMB || 0);
    this.save();
    return { ok: true, sim };
  }

  processFinanceBridge() {
    try {
      const raw = world.getDynamicProperty("carriercore:finance_bridge");
      if (!raw || typeof raw !== "string") return;
      const bridge = JSON.parse(raw);
      if (!bridge.plans) return;
      for (const [phone, record] of Object.entries(bridge.plans)) {
        if (!record || record._applied) continue;
        // find SIM by number
        for (const [, sim] of this.sims) {
          const num = String(sim.number || "").replace(/\D/g, "");
          const dest = String(phone).replace(/\D/g, "");
          if (num && dest && (num === dest || num.endsWith(dest) || dest.endsWith(num))) {
            this.applyPaidPlanToSim(sim.id, {
              id: record.planId || "plus",
              name: record.planName || "Purchased",
              texts: record.talkMin || 200,
              dataMB: (record.dataGb || 5) * 1024
            });
            record._applied = true;
          }
        }
      }
      world.setDynamicProperty("carriercore:finance_bridge", JSON.stringify(bridge));
    } catch (e) {
      console.warn("[CarrierCore] finance bridge", e);
    }
  }

  topUpSim(simId, texts = 50, dataMB = 100) {
    const sim = this.sims.get(simId);
    if (!sim) return false;
    sim.textsLeft = (sim.textsLeft || 0) + texts;
    sim.dataLeftMB = (sim.dataLeftMB || 0) + dataMB;
    sim.lastTopUp = Date.now();
    this.save();
    return true;
  }

  speedTest(player, sim) {
    const wifi = this.getPlayerWifi(player);
    if (wifi && wifi.uplink) {
      const mbps = wifi.type === "dish" ? (15 + Math.floor(Math.random() * 40)) : (50 + Math.floor(Math.random() * 150));
      return { mode: wifi.type === "dish" ? "Satellite WiFi" : "Home WiFi", mbps, note: wifi.type === "dish" ? "Sky path" : "Fiber backhaul" };
    }
    const sig = this.getBestSignal(player, sim ? sim.carrierId : null);
    if (!sig) return { mode: "None", mbps: 0, note: "No service" };
    const base = { "2G": 0.1, "3G": 2, "4G": 25, "5G": 120, "5G+": 250 }[sig.tech] || 10;
    const mbps = Math.max(0.05, base * (sig.bars / 4) * (sig.roaming ? 0.7 : 1));
    return { mode: sig.roaming ? `Cell roaming ${sig.tech}` : `Cell ${sig.tech}`, mbps: Math.round(mbps * 10) / 10, note: `${sig.bars}/4 bars · ${sig.dist}m` };
  }

  // ----- Green boxes -----
  registerGreenBox(player) {
    const id = `gb${this.nextIds.greenbox++}`;
    const x = Math.floor(player.location.x), y = Math.floor(player.location.y), z = Math.floor(player.location.z);
    const path = this.hasFiberPathToDataCenter(player.dimension, x, y, z, null);
    // path needs a carrier with DC - try any carrier DC
    let online = false;
    let steps = 0;
    for (const c of this.carriers.values()) {
      const p = this.hasFiberPathToDataCenter(player.dimension, x, y, z, c.id);
      if (p.connected) { online = true; steps = p.steps || 0; break; }
    }
    const gb = { id, x, y, z, dim: player.dimension.id, online, steps };
    this.greenBoxes.set(id, gb);
    this.save();
    return gb;
  }

  refreshGreenBox(gb, dimension) {
    let online = false, steps = 0;
    for (const c of this.carriers.values()) {
      const p = this.hasFiberPathToDataCenter(dimension, gb.x, gb.y, gb.z, c.id);
      if (p.connected) { online = true; steps = p.steps || 0; break; }
    }
    gb.online = online;
    gb.steps = steps;
    return gb;
  }

  findGreenBoxNear(x, y, z, radius = 70) {
    let best = null, bestD = radius + 1;
    for (const gb of this.greenBoxes.values()) {
      const d = Math.sqrt((gb.x - x) ** 2 + (gb.y - y) ** 2 + (gb.z - z) ** 2);
      if (d <= radius && d < bestD) { bestD = d; best = gb; }
    }
    return best ? { gb: best, dist: Math.round(bestD) } : null;
  }

  // ----- Routers -----
  registerRouter(player, ssid = "HomeNet", password = "password", security = "wpa2") {
    const id = `r${this.nextIds.router++}`;
    const x = Math.floor(player.location.x), y = Math.floor(player.location.y), z = Math.floor(player.location.z);
    const near = this.findGreenBoxNear(x, y, z, 70);
    let uplink = false, gbId = null, gbDist = null;
    if (near) {
      gbId = near.gb.id;
      gbDist = near.dist;
      try {
        this.refreshGreenBox(near.gb, player.dimension);
        uplink = !!near.gb.online;
      } catch { uplink = !!near.gb.online; }
    }
    const router = {
      id, x, y, z, dim: player.dimension.id,
      ssid: ssid || "HomeNet",
      password: password || "",
      security: security || "wpa2",
      gbId, gbDist, uplink
    };
    this.routers.set(id, router);
    this.save();
    return router;
  }

  refreshRouter(router, dimension) {
    const near = this.findGreenBoxNear(router.x, router.y, router.z, 70);
    if (!near) {
      router.uplink = false; router.gbId = null; router.gbDist = null;
      return router;
    }
    this.refreshGreenBox(near.gb, dimension);
    router.gbId = near.gb.id;
    router.gbDist = near.dist;
    router.uplink = !!near.gb.online;
    return router;
  }

  // ----- Satellite receivers & dishes -----
  registerReceiver(player, carrierId) {
    const id = `rx${this.nextIds.receiver++}`;
    const rx = {
      id, carrierId,
      x: Math.floor(player.location.x),
      y: Math.floor(player.location.y),
      z: Math.floor(player.location.z),
      dim: player.dimension.id
    };
    this.receivers.set(id, rx);
    this.save();
    return rx;
  }

  hasSky(dimension, x, y, z) {
    for (let dy = 1; dy <= 8; dy++) {
      try {
        const b = dimension.getBlock({ x, y: y + dy, z });
        if (b && b.typeId !== "minecraft:air" && b.typeId !== "minecraft:light_block") return false;
      } catch { return false; }
    }
    return true;
  }

  findReceiverForDish(dish, dimension) {
    // any receiver; prefer same carrier if set
    let best = null, bestD = 1e9;
    for (const rx of this.receivers.values()) {
      if (dish.carrierId && rx.carrierId && rx.carrierId !== dish.carrierId) continue;
      const d = Math.sqrt((rx.x - dish.x) ** 2 + (rx.y - dish.y) ** 2 + (rx.z - dish.z) ** 2);
      // satellite can be long range - allow large distance
      if (d < bestD) { bestD = d; best = rx; }
    }
    if (!best) {
      for (const rx of this.receivers.values()) {
        const d = Math.sqrt((rx.x - dish.x) ** 2 + (rx.y - dish.y) ** 2 + (rx.z - dish.z) ** 2);
        if (d < bestD) { bestD = d; best = rx; }
      }
    }
    if (!best) return null;
    // receiver needs nearby server + fiber path toward a DC of its carrier
    const hasServer = this.hasNearbyBlock(dimension, best.x, best.y, best.z, "carriercore:server_rack", 4);
    let fiberOk = false;
    if (best.carrierId) {
      const p = this.hasFiberPathToDataCenter(dimension, best.x, best.y, best.z, best.carrierId);
      fiberOk = p.connected;
    } else {
      for (const c of this.carriers.values()) {
        const p = this.hasFiberPathToDataCenter(dimension, best.x, best.y, best.z, c.id);
        if (p.connected) { fiberOk = true; break; }
      }
    }
    return { rx: best, dist: Math.round(bestD), hasServer, fiberOk, uplink: hasServer && fiberOk };
  }

  registerDish(player, ssid = "SatNet", password = "sat123", security = "wpa2", carrierId = null) {
    const id = `d${this.nextIds.dish++}`;
    const x = Math.floor(player.location.x), y = Math.floor(player.location.y), z = Math.floor(player.location.z);
    const skyOk = this.hasSky(player.dimension, x, y, z);
    const dish = {
      id, x, y, z, dim: player.dimension.id, carrierId,
      ssid: ssid || "SatNet", password: password || "", security: security || "wpa2",
      skyOk, uplink: false
    };
    const link = this.findReceiverForDish(dish, player.dimension);
    dish.uplink = !!(skyOk && link && link.uplink);
    dish.rxId = link ? link.rx.id : null;
    this.dishes.set(id, dish);
    this.save();
    return dish;
  }

  refreshDish(dish, dimension) {
    dish.skyOk = this.hasSky(dimension, dish.x, dish.y, dish.z);
    const link = this.findReceiverForDish(dish, dimension);
    dish.uplink = !!(dish.skyOk && link && link.uplink);
    dish.rxId = link ? link.rx.id : null;
    // weather penalty soft-disable
    try {
      if (typeof dimension.getWeather === "function") {
        const w = String(dimension.getWeather());
        if (w.includes("Thunder") && Math.random() < 0.3) dish.uplink = false;
      }
    } catch {}
    return dish;
  }

  // ----- Player WiFi session -----
  getPlayerWifi(player) {
    try {
      const raw = player.getDynamicProperty("carriercore:wifi");
      if (!raw || raw === "") return null;
      const data = JSON.parse(raw);
      if (data.type === "router") {
        const r = this.routers.get(data.id);
        if (!r) return null;
        this.refreshRouter(r, player.dimension);
        const dist = Math.sqrt((r.x - player.location.x) ** 2 + (r.y - player.location.y) ** 2 + (r.z - player.location.z) ** 2);
        if (dist > 24) return null; // out of WiFi range
        return { type: "router", id: r.id, ssid: r.ssid, uplink: r.uplink, dist: Math.round(dist) };
      }
      if (data.type === "dish") {
        const d = this.dishes.get(data.id);
        if (!d) return null;
        this.refreshDish(d, player.dimension);
        const dist = Math.sqrt((d.x - player.location.x) ** 2 + (d.y - player.location.y) ** 2 + (d.z - player.location.z) ** 2);
        if (dist > 24) return null;
        return { type: "dish", id: d.id, ssid: d.ssid, uplink: d.uplink, dist: Math.round(dist) };
      }
    } catch {}
    return null;
  }

  setPlayerWifi(player, type, id) {
    try {
      player.setDynamicProperty("carriercore:wifi", JSON.stringify({ type, id }));
    } catch {}
  }

  clearPlayerWifi(player) {
    try { player.setDynamicProperty("carriercore:wifi", ""); } catch {}
  }

  scanWifi(player) {
    const loc = player.location;
    const list = [];
    for (const r of this.routers.values()) {
      const dist = Math.sqrt((r.x - loc.x) ** 2 + (r.y - loc.y) ** 2 + (r.z - loc.z) ** 2);
      if (dist <= 24) {
        this.refreshRouter(r, player.dimension);
        list.push({ type: "router", id: r.id, ssid: r.ssid, security: r.security, dist: Math.round(dist), uplink: r.uplink, ref: r });
      }
    }
    for (const d of this.dishes.values()) {
      const dist = Math.sqrt((d.x - loc.x) ** 2 + (d.y - loc.y) ** 2 + (d.z - loc.z) ** 2);
      if (dist <= 24) {
        this.refreshDish(d, player.dimension);
        list.push({ type: "dish", id: d.id, ssid: d.ssid, security: d.security, dist: Math.round(dist), uplink: d.uplink, ref: d });
      }
    }
    list.sort((a, b) => a.dist - b.dist);
    return list;
  }

  connectWifi(player, entry, password) {
    const sec = entry.security || "wpa2";
    if (sec !== "open") {
      const expect = entry.ref.password || "";
      if (String(password) !== String(expect)) return { ok: false, reason: "Wrong password" };
    }
    this.setPlayerWifi(player, entry.type, entry.id);
    return { ok: true, ssid: entry.ssid, uplink: entry.uplink };
  }

  /** Preferred data path: hotspot / WiFi / cell; respects airplane mode */
  getDataPath(player, sim) {
    if (this.isAirplaneMode(player)) return { mode: "none", wifi: null, signal: null, reason: "airplane" };
    // Phone hotspot: other players could connect — for owner, hotspot uses cell
    const wifi = this.getPlayerWifi(player);
    if (wifi && wifi.uplink) return { mode: "wifi", wifi, signal: null };
    // Public WiFi captive portal handled in browseService
    const signal = this.getBestSignal(player, sim ? sim.carrierId : null);
    if (signal) return { mode: "cell", wifi: null, signal };
    return { mode: "none", wifi: null, signal: null };
  }

  isAirplaneMode(player) {
    try {
      return player.getDynamicProperty("carriercore:airplane") === true ||
        player.getDynamicProperty("carriercore:airplane") === 1;
    } catch { return false; }
  }

  setAirplaneMode(player, on) {
    try { player.setDynamicProperty("carriercore:airplane", !!on); } catch {}
    if (on) this.clearPlayerWifi(player);
  }

  // Dual SIM
  getActiveSimSlot(player, slot = 1) {
    try {
      const key = slot === 2 ? "carriercore:active_sim2" : "carriercore:active_sim";
      const id = player.getDynamicProperty(key);
      if (id && id !== "" && this.sims.has(id)) return this.sims.get(id);
    } catch {}
    return null;
  }

  setActiveSimSlot(player, simId, slot = 1) {
    if (!this.sims.has(simId)) return false;
    try {
      const key = slot === 2 ? "carriercore:active_sim2" : "carriercore:active_sim";
      player.setDynamicProperty(key, simId);
    } catch {}
    return true;
  }

  getDataSim(player) {
    try {
      const pref = player.getDynamicProperty("carriercore:data_sim_slot");
      const slot = pref === 2 ? 2 : 1;
      return this.getActiveSimSlot(player, slot) || this.getActiveSim(player);
    } catch {
      return this.getActiveSim(player);
    }
  }

  // Plans
  changePlan(simId, planId) {
    const sim = this.sims.get(simId);
    if (!sim) return { ok: false, reason: "No SIM" };
    const carrier = this.carriers.get(sim.carrierId);
    if (!carrier) return { ok: false, reason: "No carrier" };
    const plan = carrier.plans.find(p => p.id === planId);
    if (!plan) return { ok: false, reason: "Unknown plan" };
    sim.planId = plan.id;
    sim.textsLeft = plan.texts;
    sim.dataLeftMB = plan.dataMB;
    sim.lastTopUp = Date.now();
    this.save();
    return { ok: true, plan };
  }

  getUsageSummary(sim) {
    if (!sim) return null;
    const carrier = this.getCarrier(sim.carrierId);
    const plan = carrier ? carrier.plans.find(p => p.id === sim.planId) : null;
    return {
      number: sim.number,
      plan: plan ? plan.name : sim.planId,
      textsLeft: sim.textsLeft,
      dataLeftMB: sim.dataLeftMB,
      textsUsed: sim.textsUsed || 0,
      dataUsedMB: sim.dataUsedMB || 0,
      lastTopUp: sim.lastTopUp || 0,
      voicemail: (sim.voicemail || []).filter(m => !m.read).length,
      inboxUnread: (sim.inbox || []).filter(m => !m.read).length
    };
  }

  // Number portability (requires peering)
  portNumber(simId, newCarrierId) {
    const sim = this.sims.get(simId);
    if (!sim) return { ok: false, reason: "No SIM" };
    if (sim.carrierId === newCarrierId) return { ok: false, reason: "Already on that carrier" };
    if (!this.arePeers(sim.carrierId, newCarrierId)) {
      return { ok: false, reason: "Carriers must be peered to port numbers" };
    }
    const old = sim.carrierId;
    sim.carrierId = newCarrierId;
    this.save();
    return { ok: true, from: old, to: newCarrierId, number: sim.number };
  }

  // Peer roaming deals
  setPeerLimit(carrierA, carrierB, textsPerDay) {
    const k1 = `${carrierA}_${carrierB}`;
    const k2 = `${carrierB}_${carrierA}`;
    const day = Math.floor(Date.now() / 86400000);
    const entry = { textsPerDay, used: 0, day };
    this.peerLimits.set(k1, entry);
    this.peerLimits.set(k2, { ...entry });
    this.save();
    return true;
  }

  checkPeerTextLimit(fromCarrier, toCarrier) {
    const k = `${fromCarrier}_${toCarrier}`;
    const lim = this.peerLimits.get(k);
    if (!lim || !lim.textsPerDay) return { ok: true };
    const day = Math.floor(Date.now() / 86400000);
    if (lim.day !== day) { lim.day = day; lim.used = 0; }
    if (lim.used >= lim.textsPerDay) {
      return { ok: false, reason: `Roaming deal limit (${lim.textsPerDay} texts/day) reached` };
    }
    lim.used++;
    return { ok: true };
  }

  // Microwave links
  addMicrowaveLink(towerAId, towerBId) {
    const a = this.towers.get(towerAId);
    const b = this.towers.get(towerBId);
    if (!a || !b) return { ok: false, reason: "Tower not found" };
    if (a.id === b.id) return { ok: false, reason: "Same tower" };
    const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    if (dist > 128) return { ok: false, reason: "Too far for microwave (max 128m)" };
    // simple LOS: check midpoint height obstacles lightly skipped for perf
    const id = `mw${this.nextIds.mw++}`;
    this.microwaveLinks.set(id, { id, aTowerId: a.id, bTowerId: b.id, dist: Math.round(dist) });
    this.save();
    this.refreshOutages();
    this.refreshCarrierTowers(a.carrierId);
    if (b.carrierId !== a.carrierId) this.refreshCarrierTowers(b.carrierId);
    const a2 = this.towers.get(a.id);
    const b2 = this.towers.get(b.id);
    return {
      ok: true,
      id,
      dist: Math.round(dist),
      aOnline: !!(a2 && a2.online),
      bOnline: !!(b2 && b2.online),
      aVia: a2 ? a2.backhaulVia : null,
      bVia: b2 ? b2.backhaulVia : null
    };
  }

  // Maintenance
  setTowerMaintenance(towerId, on) {
    const t = this.towers.get(towerId);
    if (!t) return false;
    t.maintenance = !!on;
    this.refreshOutages();
    this.save();
    return true;
  }

  // Emergency broadcast
  emergencyBroadcast(carrierId, content) {
    const text = String(content).substring(0, 180);
    let n = 0;
    for (const sim of this.sims.values()) {
      if (sim.carrierId !== carrierId) continue;
      if (!sim.inbox) sim.inbox = [];
      sim.inbox.push({ id: `bc${Date.now()}_${n}`, from: "ALERT", content: text, at: Date.now(), read: false, broadcast: true });
      n++;
    }
    try {
      for (const p of world.getAllPlayers()) {
        const active = this.getActiveSim(p);
        if (active && active.carrierId === carrierId) {
          p.sendMessage(`§c§l[EMERGENCY] §f${text}`);
        }
      }
    } catch {}
    this.save();
    return n;
  }

  // Hotspot — phone shares cell as temporary AP
  enableHotspot(player, ssid = "PhoneHotspot") {
    const sim = this.getDataSim(player) || this.getActiveSim(player);
    if (!sim) return { ok: false, reason: "No SIM" };
    const path = this.getDataPath(player, sim);
    // temporarily clear airplane check inside: need cell
    if (this.isAirplaneMode(player)) return { ok: false, reason: "Airplane mode on" };
    const signal = this.getBestSignal(player, sim.carrierId);
    if (!signal) return { ok: false, reason: "No cell signal to share" };
    const id = `hs_${player.name}`;
    const router = {
      id, x: Math.floor(player.location.x), y: Math.floor(player.location.y), z: Math.floor(player.location.z),
      dim: player.dimension.id, ssid, password: "", security: "open",
      gbId: null, gbDist: null, uplink: true, hotspot: true, owner: player.name, simId: sim.id
    };
    this.routers.set(id, router);
    this.save();
    return { ok: true, ssid, id };
  }

  disableHotspot(player) {
    const id = `hs_${player.name}`;
    if (this.routers.has(id)) {
      this.routers.delete(id);
      this.save();
      return true;
    }
    return false;
  }

  // CDN cache near player — reduces data cost
  hasNearbyCdn(player) {
    const loc = player.location;
    for (const t of this.towers.values()) {
      // treat server_rack proximity stored on tower site as edge cache if load low
      if (!t.online) continue;
      const d = Math.sqrt((t.x - loc.x) ** 2 + (t.y - loc.y) ** 2 + (t.z - loc.z) ** 2);
      if (d <= 48 && t.hasServer) return true;
    }
    return false;
  }

  // Coverage list for map
  getCoverageReport(carrierId = null) {
    const list = [];
    for (const t of this.towers.values()) {
      if (carrierId && t.carrierId !== carrierId) continue;
      const c = this.getCarrier(t.carrierId);
      list.push({
        id: t.id,
        carrier: c ? c.name : "?",
        tech: t.tech,
        range: t.range,
        online: !!t.online,
        maintenance: !!t.maintenance,
        load: Math.round(t.load || 0),
        capacity: t.capacity,
        x: t.x, y: t.y, z: t.z,
        outage: t.outageReason || null
      });
    }
    return list;
  }

  getLoadDashboard() {
    const towers = [];
    for (const t of this.towers.values()) {
      const pct = t.capacity ? (t.load || 0) / t.capacity : 0;
      if (pct >= 0.5 || !t.online) {
        towers.push({ id: t.id, load: Math.round(t.load || 0), capacity: t.capacity, online: t.online, reason: t.outageReason });
      }
    }
    const dcs = [];
    for (const dc of this.dataCenters.values()) {
      dcs.push({
        id: dc.id,
        load: Math.round(dc.load || 0),
        capacity: dc.capacity,
        heat: dc.heat,
        cooling: dc.cooling,
        throttled: !!dc.throttled,
        outage: dc.outage || null,
        tier: dc.tier || "core"
      });
    }
    return { towers, dcs };
  }

  setDcTier(dcId, tier) {
    const dc = this.dataCenters.get(dcId);
    if (!dc) return false;
    dc.tier = tier === "regional" ? "regional" : "core";
    this.save();
    return true;
  }

  // Public WiFi flag on router
  setRouterPublic(routerId, isPublic) {
    const r = this.routers.get(routerId);
    if (!r) return false;
    r.public = !!isPublic;
    if (isPublic) { r.security = "open"; r.password = ""; }
    this.save();
    return true;
  }

  deregisterAt(x, y, z, typeHint = null) {
    const maps = [
      ["routers", this.routers],
      ["greenBoxes", this.greenBoxes],
      ["dishes", this.dishes],
      ["receivers", this.receivers]
    ];
    for (const [name, map] of maps) {
      for (const [id, o] of map.entries()) {
        if (Math.abs(o.x - x) <= 1 && Math.abs(o.y - y) <= 1 && Math.abs(o.z - z) <= 1) {
          map.delete(id);
          this.save();
          return { type: name, id };
        }
      }
    }
    return null;
  }
}
