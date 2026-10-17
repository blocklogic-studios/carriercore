import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { world, system } from "@minecraft/server";

/** Bedrock requires a tick gap between closing one form and opening another */
function nextForm(fn) {
  system.run(() => {
    try { fn(); } catch (e) { console.warn("[CarrierCore] nextForm:", e); }
  });
}

export function setupUIHandlers(network) {
  world.afterEvents.itemUse.subscribe((event) => {
    try {
      const player = event.source;
      const itemStack = event.itemStack;
      if (!player || !itemStack) return;
      const id = itemStack.typeId;
      if (id === "carriercore:network_terminal") openMainTerminal(player, network);
      else if (
        id === "carriercore:phone" ||
        id === "carriercore:iphone_17" ||
        id === "carriercore:galaxy_s25" ||
        id === "carriercore:pixel_10"
      ) openPhone(player, network, id);
    } catch (e) {
      console.warn("[CarrierCore] itemUse error:", e);
    }
  });

  // Click blocks to configure / register
  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    try {
      const player = event.player;
      const block = event.block;
      if (!player || !block) return;
      const id = block.typeId;
      if (id === "carriercore:wifi_router") {
        nextForm(() => openRouterConfig(player, network, block));
      } else if (id === "carriercore:satellite_dish") {
        nextForm(() => openDishConfig(player, network, block));
      } else if (id === "carriercore:green_box") {
        nextForm(() => openGreenBoxInfo(player, network, block));
      } else if (id === "carriercore:sat_receiver") {
        nextForm(() => openReceiverConfig(player, network, block));
      }
    } catch (e) {
      console.warn("[CarrierCore] block interact:", e);
    }
  });

  console.log("[CarrierCore] UI handlers ready");
}

function findRegisteredAt(map, x, y, z) {
  for (const o of map.values()) {
    if (Math.abs(o.x - x) <= 1 && Math.abs(o.y - y) <= 1 && Math.abs(o.z - z) <= 1) return o;
  }
  return null;
}

function openRouterConfig(player, network, block) {
  const x = block.x, y = block.y, z = block.z;
  const existing = findRegisteredAt(network.routers, x, y, z);
  const form = new ActionFormData()
    .title("WiFi Router")
    .body(existing
      ? `SSID: §f${existing.ssid}\n§7Security: ${existing.security}\nUplink: ${existing.uplink ? "§aYES" : "§cNO"} §7(GB ${existing.gbDist ?? "—"}m)`
      : "§7Not registered yet. Create a WiFi network here.")
    .button(existing ? "Reconfigure WiFi" : "Create WiFi network")
    .button("Refresh uplink status")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 1) {
      if (existing) {
        network.refreshRouter(existing, player.dimension);
        network.save();
        player.sendMessage(`§bRouter §f${existing.ssid} §7uplink: ${existing.uplink ? "§aYES" : "§cNO"} §7(green box ${existing.gbDist != null ? existing.gbDist + "m" : "none in 70 blocks"})`);
      } else {
        player.sendMessage("§cRegister the router first.");
      }
      return;
    }
    nextForm(() => configureRouterWizard(player, network, x, y, z, existing));
  }).catch((e) => {
    player.sendMessage("§cRouter menu failed: " + e);
  });
}

function configureRouterWizard(player, network, x, y, z, existing) {
  const modal = new ModalFormData()
    .title("WiFi settings")
    .textField("Network name (SSID)", existing ? existing.ssid : "HomeNet")
    .textField("Password", existing ? (existing.password || "password") : "password");
  modal.show(player).then((r) => {
    if (r.canceled) {
      player.sendMessage("§7Cancelled.");
      return;
    }
    const ssid = (r.formValues[0] || "HomeNet").toString();
    const password = (r.formValues[1] || "").toString();
    nextForm(() => {
      const secForm = new ActionFormData()
        .title("Security type")
        .body("Choose WiFi security")
        .button("WPA2 (recommended)")
        .button("WPA3")
        .button("Open (no password)");
      secForm.show(player).then((sr) => {
        if (sr.canceled) return;
        const secs = ["wpa2", "wpa3", "open"];
        const security = secs[sr.selection] || "wpa2";
        // Register at block position (not player feet if different)
        const router = registerRouterAt(network, player, x, y, z, ssid, password, security, existing);
        player.sendMessage(`§aWiFi network §f${router.ssid} §7(${router.security})`);
        player.sendMessage(`§7Uplink to green box: ${router.uplink ? "§aCONNECTED" : "§cNONE"} §8(scan radius 70)`);
        if (!router.uplink) {
          player.sendMessage("§ePlace/register a green box on fiber within 70 blocks, then refresh uplink on the router.");
        }
      }).catch((e) => player.sendMessage("§cSecurity menu failed: " + e));
    });
  }).catch((e) => {
    player.sendMessage("§cWiFi settings form failed: " + e);
    console.warn(e);
  });
}

function registerRouterAt(network, player, x, y, z, ssid, password, security, existing) {
  if (existing) {
    existing.ssid = ssid;
    existing.password = password;
    existing.security = security;
    existing.x = x; existing.y = y; existing.z = z;
    network.refreshRouter(existing, player.dimension);
    network.save();
    return existing;
  }
  // Temporarily use player location logic but override coords
  const id = `r${network.nextIds.router++}`;
  const near = network.findGreenBoxNear(x, y, z, 70);
  let uplink = false, gbId = null, gbDist = null;
  if (near) {
    gbId = near.gb.id;
    gbDist = near.dist;
    try {
      network.refreshGreenBox(near.gb, player.dimension);
      uplink = !!near.gb.online;
    } catch { uplink = !!near.gb.online; }
  }
  const router = {
    id, x, y, z, dim: player.dimension.id,
    ssid, password, security, gbId, gbDist, uplink
  };
  network.routers.set(id, router);
  network.save();
  return router;
}

function openDishConfig(player, network, block) {
  const x = block.x, y = block.y, z = block.z;
  const existing = findRegisteredAt(network.dishes, x, y, z);
  const form = new ActionFormData()
    .title("Satellite Dish")
    .body(existing
      ? `SSID: §f${existing.ssid}\n§7Sky: ${existing.skyOk ? "§aOK" : "§cBlocked"} · Uplink: ${existing.uplink ? "§aYES" : "§cNO"}`
      : "§7Not registered. Configure dish WiFi + link to DC receivers.")
    .button(existing ? "Reconfigure" : "Setup dish WiFi")
    .button("Refresh status")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 1) {
      if (existing) {
        network.refreshDish(existing, player.dimension);
        network.save();
        player.sendMessage(`§bDish §f${existing.ssid} §7sky ${existing.skyOk ? "OK" : "blocked"} uplink ${existing.uplink ? "YES" : "NO"}`);
      } else player.sendMessage("§cSetup the dish first.");
      return;
    }
    nextForm(() => configureDishWizard(player, network, x, y, z, existing));
  }).catch((e) => player.sendMessage("§cDish menu failed: " + e));
}

function configureDishWizard(player, network, x, y, z, existing) {
  const modal = new ModalFormData()
    .title("Dish WiFi settings")
    .textField("Network name (SSID)", existing ? existing.ssid : "SatNet")
    .textField("Password", existing ? (existing.password || "sat123") : "sat123");
  modal.show(player).then((r) => {
    if (r.canceled) return;
    const ssid = (r.formValues[0] || "SatNet").toString();
    const password = (r.formValues[1] || "").toString();
    nextForm(() => {
      const secForm = new ActionFormData().title("Security")
        .button("WPA2").button("WPA3").button("Open");
      secForm.show(player).then((sr) => {
        if (sr.canceled) return;
        const secs = ["wpa2", "wpa3", "open"];
        const security = secs[sr.selection] || "wpa2";
        const dish = registerDishAt(network, player, x, y, z, ssid, password, security, existing);
        player.sendMessage(`§aDish WiFi §f${dish.ssid} §7(${dish.security})`);
        player.sendMessage(`§7Sky: ${dish.skyOk ? "§aCLEAR" : "§cBLOCKED"} · Uplink: ${dish.uplink ? "§aYES" : "§cNO"}`);
        if (!dish.skyOk) player.sendMessage("§eClear blocks above the dish.");
        if (!dish.uplink) player.sendMessage("§eNeed sat receiver at DC + server rack + fiber to DC.");
      });
    });
  }).catch((e) => player.sendMessage("§cDish form failed: " + e));
}

function registerDishAt(network, player, x, y, z, ssid, password, security, existing) {
  if (existing) {
    existing.ssid = ssid;
    existing.password = password;
    existing.security = security;
    existing.x = x; existing.y = y; existing.z = z;
    network.refreshDish(existing, player.dimension);
    network.save();
    return existing;
  }
  const id = `d${network.nextIds.dish++}`;
  const dish = {
    id, x, y, z, dim: player.dimension.id, carrierId: null,
    ssid, password, security, skyOk: false, uplink: false, rxId: null
  };
  network.refreshDish(dish, player.dimension);
  network.dishes.set(id, dish);
  network.save();
  return dish;
}

function openGreenBoxInfo(player, network, block) {
  let gb = findRegisteredAt(network.greenBoxes, block.x, block.y, block.z);
  const form = new ActionFormData()
    .title("Fiber Green Box")
    .body(gb
      ? `§7ID: ${gb.id}\nFiber→DC: ${gb.online ? "§aONLINE" : "§cOFFLINE"}`
      : "§7Not registered. Register to join the fiber network.")
    .button(gb ? "Refresh status" : "Register this green box")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 1) return;
    if (gb) {
      network.refreshGreenBox(gb, player.dimension);
      network.save();
      player.sendMessage(`§bGreen box §f${gb.id} §7fiber→DC: ${gb.online ? "§aONLINE" : "§cOFFLINE"}`);
    } else {
      const id = `gb${network.nextIds.greenbox++}`;
      const x = block.x, y = block.y, z = block.z;
      gb = { id, x, y, z, dim: player.dimension.id, online: false, steps: 0 };
      network.refreshGreenBox(gb, player.dimension);
      network.greenBoxes.set(id, gb);
      network.save();
      player.sendMessage(`§aGreen box §f${gb.id} §7fiber→DC: ${gb.online ? "§aONLINE" : "§cOFFLINE"}`);
    }
  }).catch((e) => player.sendMessage("§cGreen box menu failed: " + e));
}

function openReceiverConfig(player, network, block) {
  const existing = findRegisteredAt(network.receivers, block.x, block.y, block.z);
  if (existing) {
    const c = network.getCarrier(existing.carrierId);
    player.sendMessage(`§bSat receiver §f${existing.id} §7carrier: ${c ? c.name : existing.carrierId}`);
    return;
  }
  if (network.carriers.size === 0) {
    player.sendMessage("§cCreate a carrier first (Terminal).");
    return;
  }
  const list = Array.from(network.carriers.values());
  const form = new ActionFormData().title("Register Sat Receiver");
  list.forEach(c => form.button(c.name));
  form.show(player).then((res) => {
    if (res.canceled) return;
    const id = `rx${network.nextIds.receiver++}`;
    const rx = {
      id, carrierId: list[res.selection].id,
      x: block.x, y: block.y, z: block.z,
      dim: player.dimension.id
    };
    network.receivers.set(id, rx);
    network.save();
    player.sendMessage(`§aSat receiver §f${rx.id} §7for ${list[res.selection].name}`);
  }).catch((e) => player.sendMessage("§cReceiver menu failed: " + e));
}

function openMainTerminal(player, network) {
  player.sendMessage("§b[CarrierCore] §fOpening Network Terminal...");
  const form = new ActionFormData()
    .title("Network Management Terminal")
    .body(`Carriers: ${network.carriers.size} | Towers: ${network.towers.size} | DCs: ${network.dataCenters.size}\nRouters: ${network.routers.size} | MW links: ${network.microwaveLinks.size}`)
    .button("Carriers")
    .button("Register Tower (here)")
    .button("Register Data Center")
    .button("Create / Join IXP & Peering")
    .button("Create SIM")
    .button("Internet Services")
    .button("Home & Satellite")
    .button("Network Ops")
    .button("Message Queue & Status");

  form.show(player).then((res) => {
    if (res.canceled) return;
    nextForm(() => {
      switch (res.selection) {
        case 0: openCarriers(player, network); break;
        case 1: registerTowerUI(player, network); break;
        case 2: registerDCUI(player, network); break;
        case 3: openPeeringUI(player, network); break;
        case 4: createSimUI(player, network); break;
        case 5: openServicesUI(player, network); break;
        case 6: openHomeSatUI(player, network); break;
        case 7: openNetworkOps(player, network); break;
        case 8: showStatus(player, network); break;
      }
    });
  }).catch((e) => {
    player.sendMessage("§c[CarrierCore] Menu failed. Enable Beta APIs?");
    console.warn("[CarrierCore] form error:", e);
  });
}

function openCarriers(player, network) {
  const form = new ActionFormData().title("Carriers")
    .button("Create New Carrier").button("List Carriers").button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return nextForm(() => openMainTerminal(player, network));
    if (res.selection === 0) {
      nextForm(() => {
        const modal = new ModalFormData().title("Create Carrier").textField("Name", "MyCarrier");
        modal.show(player).then((r) => {
          if (r.canceled) return;
          const c = network.createCarrier(r.formValues[0] || "Unnamed");
          player.sendMessage(`§aCreated §f${c.name} §7(${c.id})`);
        }).catch((e) => player.sendMessage("§cForm failed: " + e));
      });
    } else {
      for (const c of network.carriers.values())
        player.sendMessage(`${c.color}${c.name} §7T:${c.towers.length} DC:${c.dataCenters.length}`);
    }
  });
}

function registerTowerUI(player, network) {
  if (network.carriers.size === 0) return player.sendMessage("§cCreate a carrier first.");
  const list = Array.from(network.carriers.values());
  const form = new ActionFormData().title("Select Carrier");
  list.forEach(c => form.button(c.name));
  form.show(player).then((res) => {
    if (res.canceled) return;
    nextForm(() => {
      const carrier = list[res.selection];
      const techForm = new ActionFormData().title("Tower Radio Tech")
        .button("2G").button("3G").button("4G").button("5G").button("5G+");
      const techs = ["2G", "3G", "4G", "5G", "5G+"];
      techForm.show(player).then((tr) => {
        if (tr.canceled) return;
        const result = network.registerTower(player, carrier.id, { tech: techs[tr.selection] || "4G" });
        const { tower, validation, rejected, pendingBackhaul } = result;
        if (rejected) {
          player.sendMessage("§cTower NOT registered – incomplete site.");
          player.sendMessage(`§7Base: ${validation.base ? "§aOK" : "§cNo"} §7BBU: ${validation.hasServer ? "§aOK" : "§cNo"} §7Ant feed: ${validation.antennaWiredToBbu ? "§aOK" : "§cNo"}`);
          player.sendMessage(`§7Power: ${validation.hasPower ? "§aOK" : "§cNo"} §7Cooling: ${validation.hasCooling ? "§aOK" : "§cNo"}`);
          if (!validation.antennaWiredToBbu) {
            player.sendMessage("§8Run fiber from BBU up the mast to the antenna (up to 100 blocks).");
          }
          return;
        }
        if (pendingBackhaul || !tower.online) {
          player.sendMessage(`§eTower §f${tower.id} §7registered but §cOFFLINE §7– no backhaul yet.`);
          player.sendMessage("§7Option A: run §ffiber §7from this site to a DC");
          player.sendMessage("§7Option B: Network Ops → §fMicrowave link §7to a tower that already has fiber (≤128m)");
        } else {
          player.sendMessage(`§aTower §f${tower.id} §7${tower.tech} range ${tower.range} §aONLINE §8(${tower.backhaulVia || "fiber"})`);
          if (validation.antennaHeight) player.sendMessage(`§7Antenna height ~${validation.antennaHeight} blocks (fiber feed)`);
        }
      });
    });
  });
}

function registerDCUI(player, network) {
  if (network.carriers.size === 0) return player.sendMessage("§cCreate a carrier first.");
  const list = Array.from(network.carriers.values());
  const form = new ActionFormData().title("Select Carrier for Data Center");
  list.forEach(c => form.button(c.name));
  form.show(player).then((res) => {
    if (res.canceled) return;
    const dc = network.registerDataCenter(player, list[res.selection].id);
    player.sendMessage(`§aData Center §f${dc.id} §7registered`);
  });
}

function openPeeringUI(player, network) {
  const form = new ActionFormData().title("Peering & IXPs")
    .button("Create IXP here").button("Peer two carriers")
    .button("Set roaming text limit").button("List").button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 4) return nextForm(() => openMainTerminal(player, network));
    if (res.selection === 0) {
      const ixp = network.createIXP(player, "Exchange-" + network.nextIds.ixp);
      player.sendMessage(`§aIXP §f${ixp.name}`);
    } else if (res.selection === 1) {
      const list = Array.from(network.carriers.values());
      if (list.length < 2) return player.sendMessage("§cNeed 2 carriers.");
      nextForm(() => {
        const f1 = new ActionFormData().title("First"); list.forEach(c => f1.button(c.name));
        f1.show(player).then((r1) => {
          if (r1.canceled) return;
          nextForm(() => {
            const f2 = new ActionFormData().title("Second"); list.forEach(c => f2.button(c.name));
            f2.show(player).then((r2) => {
              if (r2.canceled) return;
              if (network.addPeer(list[r1.selection].id, list[r2.selection].id))
                player.sendMessage(`§aPeered §f${list[r1.selection].name} ↔ ${list[r2.selection].name}`);
            });
          });
        });
      });
    } else if (res.selection === 2) {
      const list = Array.from(network.carriers.values());
      if (list.length < 2) return player.sendMessage("§cNeed 2 carriers.");
      nextForm(() => {
        const f1 = new ActionFormData().title("From carrier"); list.forEach(c => f1.button(c.name));
        f1.show(player).then((r1) => {
          if (r1.canceled) return;
          nextForm(() => {
            const f2 = new ActionFormData().title("To carrier"); list.forEach(c => f2.button(c.name));
            f2.show(player).then((r2) => {
              if (r2.canceled) return;
              nextForm(() => {
                const lim = new ActionFormData().title("Daily roaming texts")
                  .button("10").button("50").button("200").button("Unlimited");
                lim.show(player).then((lr) => {
                  if (lr.canceled) return;
                  const vals = [10, 50, 200, 0];
                  network.setPeerLimit(list[r1.selection].id, list[r2.selection].id, vals[lr.selection]);
                  player.sendMessage(`§aRoaming deal set: §f${vals[lr.selection] || "unlimited"} §7texts/day`);
                });
              });
            });
          });
        });
      });
    } else {
      player.sendMessage(`§7IXPs ${network.ixps.size} · peers ${network.peers.size}`);
    }
  });
}

function createSimUI(player, network) {
  if (network.carriers.size === 0) return player.sendMessage("§cCreate a carrier first.");
  const list = Array.from(network.carriers.values());
  const form = new ActionFormData().title("Carrier for SIM");
  list.forEach(c => form.button(c.name));
  form.show(player).then((res) => {
    if (res.canceled) return;
    const sim = network.createSim(list[res.selection].id, "basic", player.name);
    if (sim) {
      network.setActiveSim(player, sim.id);
      player.sendMessage(`§aSIM §f${sim.number} §7auto-inserted`);
      try { player.runCommand("give @s carriercore:sim_card 1"); } catch {}
    }
  });
}

function openServicesUI(player, network) {
  const form = new ActionFormData().title("Internet Services")
    .button("Host Weather").button("Host News").button("Host Sports")
    .button("Host Carrier portal").button("Host Custom").button("List sites").button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 6) return nextForm(() => openMainTerminal(player, network));
    if (res.selection === 5) {
      for (const s of network.services.values()) {
        const h = network.getCarrier(s.hostCarrierId);
        player.sendMessage(`§b${s.name} §8[${s.type}] §f${h ? h.name : "?"}`);
      }
      return;
    }
    if (network.carriers.size === 0) return player.sendMessage("§cCreate a carrier first.");
    const types = ["weather", "news", "sports", "carrier", "custom"];
    const defaults = [
      { name: "WeatherLive", path: "/forecast" },
      { name: "WorldNews", path: "/top" },
      { name: "SportsWire", path: "/scores" },
      { name: "MyCarrier", path: "/portal" },
      { name: "MySite", path: "/home" }
    ];
    const type = types[res.selection];
    const def = defaults[res.selection];
    const list = Array.from(network.carriers.values());
    nextForm(() => {
      const cf = new ActionFormData().title("Host carrier");
      list.forEach(c => cf.button(c.name));
      cf.show(player).then((cr) => {
        if (cr.canceled) return;
        const carrier = list[cr.selection];
        if (type === "custom") {
          nextForm(() => {
            const modal = new ModalFormData().title("Custom").textField("Name", def.name).textField("Path", def.path);
            modal.show(player).then((mr) => {
              if (mr.canceled) return;
              const svc = network.createService(carrier.id, mr.formValues[0] || def.name, mr.formValues[1] || "/", type);
              if (svc) player.sendMessage(`§aHosted §f${svc.name}`);
            });
          });
        } else {
          const svc = network.createService(carrier.id, def.name, def.path, type);
          if (svc) player.sendMessage(`§aHosted §f${svc.name} §7(${type})`);
        }
      });
    });
  });
}

function openHomeSatUI(player, network) {
  const form = new ActionFormData().title("Home & Satellite")
    .body("§7Tip: You can also §fclick the blocks§7 to configure them.\nGreen box on fiber · Router scans 70m · Dish needs sky + receivers")
    .button("Register Green Box at my feet")
    .button("Register Router at my feet")
    .button("Register Sat Receiver at my feet")
    .button("Register Dish at my feet")
    .button("List gear")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 5) return nextForm(() => openMainTerminal(player, network));
    if (res.selection === 0) {
      const gb = network.registerGreenBox(player);
      player.sendMessage(`§aGreen box §f${gb.id} §7fiber→DC: ${gb.online ? "§aONLINE" : "§cOFFLINE"}`);
    } else if (res.selection === 1) {
      player.sendMessage("§eOpening router setup…");
      nextForm(() => {
        const x = Math.floor(player.location.x), y = Math.floor(player.location.y), z = Math.floor(player.location.z);
        configureRouterWizard(player, network, x, y, z, null);
      });
    } else if (res.selection === 2) {
      if (network.carriers.size === 0) return player.sendMessage("§cCreate a carrier first.");
      nextForm(() => {
        const list = Array.from(network.carriers.values());
        const cf = new ActionFormData().title("Receiver carrier");
        list.forEach(c => cf.button(c.name));
        cf.show(player).then((cr) => {
          if (cr.canceled) return;
          const rx = network.registerReceiver(player, list[cr.selection].id);
          player.sendMessage(`§aSat receiver §f${rx.id} §7for ${list[cr.selection].name}`);
        }).catch((e) => player.sendMessage("§cFailed: " + e));
      });
    } else if (res.selection === 3) {
      player.sendMessage("§eOpening dish setup…");
      nextForm(() => {
        const x = Math.floor(player.location.x), y = Math.floor(player.location.y), z = Math.floor(player.location.z);
        configureDishWizard(player, network, x, y, z, null);
      });
    } else {
      player.sendMessage(`§7GB ${network.greenBoxes.size} · Routers ${network.routers.size} · Dishes ${network.dishes.size} · RX ${network.receivers.size}`);
      for (const r of network.routers.values())
        player.sendMessage(`§bWiFi §f${r.ssid} §7uplink ${r.uplink ? "yes" : "no"}`);
      for (const d of network.dishes.values())
        player.sendMessage(`§dSat §f${d.ssid} §7sky ${d.skyOk} uplink ${d.uplink}`);
    }
  }).catch((e) => player.sendMessage("§cHome/Sat menu failed: " + e));
}

function showStatus(player, network) {
  player.sendMessage("§l§b=== Network Status ===");
  player.sendMessage(`§7Carriers ${network.carriers.size} · Towers ${network.towers.size} · Sites ${network.services.size}`);
  for (const m of network.messages.slice(-5))
    player.sendMessage(`§8${m.from}→${m.to}: ${m.status}`);
}

function openPhone(player, network, phoneModel = "carriercore:phone") {
  player.sendMessage("§b[CarrierCore] §fOpening phone...");
  if (network.isAirplaneMode(player)) {
    player.sendMessage("§eAirplane mode is ON – radio disabled.");
  }
  const active = network.getActiveSim(player);
  const active2 = network.getActiveSimSlot(player, 2);
  const path = network.getDataPath(player, active);
  const wifi = path.wifi;
  const signal = path.signal;

  let netLine = "§cNo Service";
  if (network.isAirplaneMode(player)) netLine = "§7Airplane mode";
  else if (path.mode === "wifi") {
    netLine = `§aWiFi §f${wifi.ssid} §7(${wifi.type === "dish" ? "Sat" : "Home"})`;
  } else if (path.mode === "cell") {
    const bars = "▮".repeat(signal.bars) + "▯".repeat(4 - signal.bars);
    const roam = signal.roaming ? " §eROAM" : "";
    netLine = `§a${bars} §f${signal.tech}${roam} §7${signal.dist}m`;
  }

  const simText = active
    ? `§f${active.number}${active2 ? " §8+slot2" : ""} §7(${active.textsLeft}t · ${active.dataLeftMB}MB)`
    : "§cNo SIM";

  const modelName = {
    "carriercore:iphone_17": "iPhone 17",
    "carriercore:galaxy_s25": "Galaxy S25",
    "carriercore:pixel_10": "Pixel 10",
    "carriercore:phone": "Phone"
  }[phoneModel] || "Phone";
  const form = new ActionFormData()
    .title(modelName)
    .body(`Network: ${netLine}\nSIM: ${simText}`)
    .button("Send Text")
    .button("Inbox & Voicemail")
    .button("Apps")
    .button("WiFi")
    .button("Hotspot")
    .button("Contacts")
    .button("Usage & Plan")
    .button("SIM Manager")
    .button("Airplane Mode")
    .button("Signal Details");

  form.show(player).then((res) => {
    if (res.canceled) return;
    const s = res.selection;
    if (s === 0) {
      if (!active) return player.sendMessage("§cInsert a SIM first.");
      if (network.isAirplaneMode(player)) return player.sendMessage("§cAirplane mode.");
      if (path.mode === "none") return player.sendMessage("§cNo signal.");
      nextForm(() => {
        const modal = new ModalFormData().title("Send Text")
          .textField("To Number", "200-300-1000")
          .textField("Message", "Hello");
        modal.show(player).then((r) => {
          if (r.canceled) return;
          const result = network.sendText(active.id, r.formValues[0], r.formValues[1] || "");
          if (result.ok) player.sendMessage(`§aQueued to ${result.message.to}`);
          else player.sendMessage(`§c${result.reason}`);
        });
      });
    } else if (s === 1) {
      if (!active) return player.sendMessage("§cNo SIM.");
      const inbox = active.inbox || [];
      const vm = active.voicemail || [];
      player.sendMessage("§l§b=== Inbox ===");
      if (!inbox.length) player.sendMessage("§7Empty");
      else for (const m of inbox.slice(-8)) {
        player.sendMessage(`§a${m.from}: §f${m.content}`);
        m.read = true;
      }
      player.sendMessage("§l§e=== Voicemail ===");
      if (!vm.length) player.sendMessage("§7Empty");
      else for (const m of vm.slice(-8)) {
        player.sendMessage(`§e${m.from}: §f${m.content}`);
        m.read = true;
      }
      network.save();
    } else if (s === 2) {
      nextForm(() => openApps(player, network, active));
    } else if (s === 3) {
      nextForm(() => openWifiMenu(player, network));
    } else if (s === 4) {
      nextForm(() => openHotspotMenu(player, network));
    } else if (s === 5) {
      nextForm(() => openContacts(player, network, active));
    } else if (s === 6) {
      nextForm(() => openUsagePlan(player, network, active));
    } else if (s === 7) {
      nextForm(() => openSimManager(player, network));
    } else if (s === 8) {
      const on = !network.isAirplaneMode(player);
      network.setAirplaneMode(player, on);
      player.sendMessage(on ? "§eAirplane mode §lON" : "§aAirplane mode §lOFF");
    } else if (s === 9) {
      if (path.mode === "wifi") player.sendMessage(`§aWiFi ${wifi.ssid} · ${wifi.type} · uplink ${wifi.uplink}`);
      else if (signal) player.sendMessage(`§a${signal.bars}/4 ${signal.tech}${signal.roaming ? " ROAM" : ""} · ${signal.dist}m · ${signal.tower.id}`);
      else player.sendMessage("§cNo service");
    }
  }).catch((e) => {
    player.sendMessage("§cPhone menu failed.");
    console.warn(e);
  });
}

function openWifiMenu(player, network) {
  const cur = network.getPlayerWifi(player);
  const form = new ActionFormData().title("WiFi")
    .body(cur ? `Connected: §f${cur.ssid} §7uplink ${cur.uplink}` : "§7Not connected")
    .button("Scan networks")
    .button("Disconnect")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return nextForm(() => openPhone(player, network));
    if (res.selection === 1) {
      network.clearPlayerWifi(player);
      player.sendMessage("§eWiFi disconnected – cell fallback if available.");
      return;
    }
    const list = network.scanWifi(player);
    if (!list.length) return player.sendMessage("§7No WiFi in range (24m). Register a router/dish first.");
    nextForm(() => {
      const sf = new ActionFormData().title("Networks");
      list.forEach(e => sf.button(`${e.ssid} [${e.security}] ${e.dist}m ${e.uplink ? "§aUP" : "§cDOWN"}`));
      sf.show(player).then((sr) => {
        if (sr.canceled) return;
        const entry = list[sr.selection];
        if (entry.security === "open") {
          const r = network.connectWifi(player, entry, "");
          player.sendMessage(r.ok ? `§aConnected to §f${r.ssid}` : `§c${r.reason}`);
        } else {
          nextForm(() => {
            const modal = new ModalFormData().title(`Join ${entry.ssid}`).textField("Password", "");
            modal.show(player).then((mr) => {
              if (mr.canceled) return;
              const r = network.connectWifi(player, entry, mr.formValues[0] || "");
              player.sendMessage(r.ok ? `§aConnected to §f${r.ssid}` : `§c${r.reason}`);
            });
          });
        }
      });
    });
  });
}

function openContacts(player, network, active) {
  const list = network.getContacts(player.name);
  const form = new ActionFormData().title("Contacts")
    .button("Add contact").button("List contacts").button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return nextForm(() => openPhone(player, network));
    if (res.selection === 0) {
      nextForm(() => {
        const modal = new ModalFormData().title("Add contact")
          .textField("Name", "Name").textField("Number", "200-300-1000");
        modal.show(player).then((r) => {
          if (r.canceled) return;
          if (network.addContact(player.name, r.formValues[0], r.formValues[1]))
            player.sendMessage(`§aSaved §f${r.formValues[0]}`);
          else player.sendMessage("§cFailed");
        });
      });
    } else {
      if (!list.length) player.sendMessage("§7No contacts.");
      else list.forEach(c => player.sendMessage(`§f${c.name} §7${c.number}`));
    }
  });
}


function openApps(player, network, active) {
  const form = new ActionFormData().title("Apps")
    .button("Browser")
    .button("Weather")
    .button("News")
    .button("Speed Test")
    .button("Maps (coords)")
    .button("Coverage")
    .button("Calculator")
    .button("Notes")
    .button("Clock")
    .button("Settings")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 10) return nextForm(() => openPhone(player, network));
    const s = res.selection;
    if (s === 3) {
      const st = network.speedTest(player, active);
      player.sendMessage(`§bSpeed Test §f${st.mode}: §a${st.mbps} Mbps §7(${st.note})`);
      return;
    }
    if (s === 4) {
      const loc = player.location;
      player.sendMessage(`§bMaps §fX:${Math.floor(loc.x)} Y:${Math.floor(loc.y)} Z:${Math.floor(loc.z)}`);
      player.sendMessage(`§7Dimension: ${player.dimension.id}`);
      return;
    }
    if (s === 5) {
      const path = network.getDataPath(player, active);
      if (path.mode === "cell" && path.signal) {
        player.sendMessage(`§bCoverage §f${path.signal.tech} ${path.signal.bars}/4 · ${path.signal.dist}m from ${path.signal.tower.id}`);
      } else if (path.mode === "wifi") {
        player.sendMessage(`§bCoverage §fWiFi ${path.wifi.ssid}`);
      } else player.sendMessage("§cNo coverage");
      return;
    }
    if (s === 6) {
      nextForm(() => {
        const m = new ModalFormData().title("Calculator").textField("Expression (e.g. 12+5*3)", "1+1");
        m.show(player).then((r) => {
          if (r.canceled) return;
          try {
            const expr = String(r.formValues[0] || "").replace(/[^0-9+\-*/(). ]/g, "");
            // eslint-disable-next-line no-new-func
            const val = Function(`"use strict"; return (${expr})`)();
            player.sendMessage(`§bCalc §f${expr} = §a${val}`);
          } catch {
            player.sendMessage("§cInvalid expression");
          }
        });
      });
      return;
    }
    if (s === 7) {
      nextForm(() => {
        const m = new ModalFormData().title("Notes").textField("Note", "Remember to...");
        m.show(player).then((r) => {
          if (r.canceled) return;
          try {
            player.setDynamicProperty("carriercore:note", String(r.formValues[0] || "").slice(0, 200));
          } catch {}
          player.sendMessage("§aNote saved.");
        });
      });
      return;
    }
    if (s === 8) {
      try {
        const t = world.getTimeOfDay ? world.getTimeOfDay() : 0;
        player.sendMessage(`§bClock §fDay time tick: ${t}`);
      } catch {
        player.sendMessage("§bClock §7(time unavailable)");
      }
      return;
    }
    if (s === 9) {
      player.sendMessage("§l§bSettings");
      player.sendMessage("§7Use phone menu for Airplane, WiFi, SIM, Hotspot.");
      try {
        const note = player.getDynamicProperty("carriercore:note");
        if (note) player.sendMessage(`§7Saved note: §f${note}`);
      } catch {}
      return;
    }
    // Browser / Weather / News need data
    if (!active) return player.sendMessage("§cNeed SIM.");
    if (network.isAirplaneMode(player)) return player.sendMessage("§cAirplane mode.");
    const path = network.getDataPath(player, active);
    if (path.mode === "none") return player.sendMessage("§cNo data path.");
    const sites = Array.from(network.services.values());
    const openSite = (pred, missingMsg) => {
      const site = typeof pred === "function" ? sites.find(pred) : null;
      if (!site) return player.sendMessage(missingMsg);
      const result = network.browseService(player, active.id, site.id);
      if (result.ok) player.sendMessage(result.page);
      else if (result.captive) {
        try { player.setDynamicProperty("carriercore:captive_ok_" + result.apId, true); } catch {}
        const retry = network.browseService(player, active.id, site.id);
        if (retry.ok) player.sendMessage(retry.page);
        else player.sendMessage(`§c${retry.reason}`);
      } else player.sendMessage(`§c${result.reason}`);
    };
    if (s === 0) return nextForm(() => openPhoneBrowser(player, network, active));
    if (s === 1) return openSite(x => x.type === "weather", "§7No weather site. Host one in Terminal.");
    if (s === 2) return openSite(x => x.type === "news", "§7No news site. Host one in Terminal.");
    if (!sites.length) return player.sendMessage("§7No sites hosted.");
    nextForm(() => {
      const sf = new ActionFormData().title("Browser");
      for (const site of sites) {
        const carr = network.getCarrier(site.hostCarrierId);
        sf.button(`${site.name} (${carr ? carr.name : "?"})`);
      }
      sf.show(player).then((sr) => {
        if (sr.canceled) return;
        const result = network.browseService(player, active.id, sites[sr.selection].id);
        if (result.ok) player.sendMessage(result.page);
        else if (result.captive) {
          try { player.setDynamicProperty("carriercore:captive_ok_" + result.apId, true); } catch {}
          const retry = network.browseService(player, active.id, sites[sr.selection].id);
          if (retry.ok) player.sendMessage(retry.page);
          else player.sendMessage(`§c${retry.reason}`);
        } else player.sendMessage(`§c${result.reason}`);
      });
    });
  });
}

/** Phone browser: pay for plans & shop with FinanceCore card (Luhn PAN) */
function openPhoneBrowser(player, network, active) {
  const fc = network.isFinanceCorePresent();
  const form = new ActionFormData()
    .title("Browser")
    .body(
      fc
        ? "§aFinanceCore linked§7 — buy a mobile plan with your embossed card"
        : "§eEnable FinanceCore§7 to pay for plans with a card number"
    )
    .button("Carrier Store — buy plan")
    .button("Hosted sites")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return nextForm(() => openApps(player, network, active));
    if (res.selection === 0) return nextForm(() => openCarrierStore(player, network, active));
    if (res.selection === 1) {
      const sites = Array.from(network.services.values());
      if (!sites.length) return player.sendMessage("§7No sites hosted. Use Terminal to host.");
      nextForm(() => {
        const sf = new ActionFormData().title("Sites");
        for (const site of sites) {
          const carr = network.getCarrier(site.hostCarrierId);
          sf.button(`${site.name} (${carr ? carr.name : "?"})`);
        }
        sf.show(player).then((sr) => {
          if (sr.canceled) return;
          const result = network.browseService(player, active.id, sites[sr.selection].id);
          if (result.ok) player.sendMessage(result.page);
          else player.sendMessage(`§c${result.reason}`);
        });
      });
    }
  });
}

function openCarrierStore(player, network, active) {
  if (!network.isFinanceCorePresent()) {
    player.sendMessage("§cFinanceCore required. Enable FinanceCore Behavior + Resources.");
    return nextForm(() => openPhoneBrowser(player, network, active));
  }
  const plans = network.getBrowserPlans();
  const form = new ActionFormData()
    .title("Carrier Store")
    .body(`§7Paying for SIM §f${active.number}
§7Enter embossed card PAN + CVV`);
  for (const p of plans) {
    form.button(`${p.name}
§a$${p.price.toFixed(2)} §8${p.texts} texts · ${p.dataMB} MB`);
  }
  form.button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === plans.length) {
      return nextForm(() => openPhoneBrowser(player, network, active));
    }
    const plan = plans[res.selection];
    nextForm(() => {
      const modal = new ModalFormData()
        .title(`Buy ${plan.name}`)
        .textField("Card number", "4510...")
        .textField("Expiry MM/YY", "12/29")
        .textField("CVV", "123");
      modal.show(player).then((r) => {
        if (r.canceled) return;
        const pay = network.chargeFinanceCard(
          r.formValues[0],
          r.formValues[1],
          r.formValues[2],
          plan.price,
          `Carrier plan ${plan.name}`
        );
        if (!pay.ok) {
          player.sendMessage(`§c${pay.reason}`);
          return;
        }
        const applied = network.applyPaidPlanToSim(active.id, plan);
        try { network.recordPlanPurchaseBridge(active, plan, pay.last4); } catch (e) {}
        if (!applied.ok) {
          player.sendMessage(`§cPaid but plan apply failed: ${applied.reason}`);
          return;
        }
        player.sendMessage(
          `§a${plan.name} active on §f${active.number}
§7Charged ••${pay.last4} · $${plan.price.toFixed(2)}`
        );
      });
    });
  });
}


function openHotspotMenu(player, network) {
  const form = new ActionFormData().title("Mobile Hotspot")
    .body("Share your cell data as open WiFi nearby.")
    .button("Enable hotspot")
    .button("Disable hotspot")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return nextForm(() => openPhone(player, network));
    if (res.selection === 0) {
      const r = network.enableHotspot(player, player.name + "-Hotspot");
      if (r.ok) player.sendMessage(`§aHotspot §f${r.ssid} §7on – others can join within 24m`);
      else player.sendMessage(`§c${r.reason}`);
    } else {
      network.disableHotspot(player);
      player.sendMessage("§eHotspot off");
    }
  });
}

function openUsagePlan(player, network, active) {
  if (!active) return player.sendMessage("§cNo SIM.");
  const u = network.getUsageSummary(active);
  const form = new ActionFormData().title("Usage & Plan")
    .body(`§f${u.number}\n§7Plan: §f${u.plan}\n§7Left: ${u.textsLeft} texts · ${u.dataLeftMB} MB\n§7Used: ${u.textsUsed} texts · ${u.dataUsedMB} MB\n§7Unread VM: ${u.voicemail}`)
    .button("Top up +50 texts / +100 MB")
    .button("Change plan")
    .button("Port number to other carrier")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 3) return nextForm(() => openPhone(player, network));
    if (res.selection === 0) {
      network.topUpSim(active.id, 50, 100);
      player.sendMessage("§aTopped up.");
    } else if (res.selection === 1) {
      nextForm(() => {
        const pf = new ActionFormData().title("Select plan")
          .button("Basic").button("Plus").button("Unlimited");
        const ids = ["basic", "plus", "unl"];
        pf.show(player).then((pr) => {
          if (pr.canceled) return;
          const r = network.changePlan(active.id, ids[pr.selection]);
          if (r.ok) player.sendMessage(`§aPlan → §f${r.plan.name}`);
          else player.sendMessage(`§c${r.reason}`);
        });
      });
    } else if (res.selection === 2) {
      const list = Array.from(network.carriers.values()).filter(c => c.id !== active.carrierId);
      if (!list.length) return player.sendMessage("§cNo other carriers.");
      nextForm(() => {
        const f = new ActionFormData().title("Port to carrier");
        list.forEach(c => f.button(c.name));
        f.show(player).then((r) => {
          if (r.canceled) return;
          const result = network.portNumber(active.id, list[r.selection].id);
          if (result.ok) player.sendMessage(`§aPorted §f${result.number} §7to ${list[r.selection].name}`);
          else player.sendMessage(`§c${result.reason}`);
        });
      });
    }
  });
}

function openSimManager(player, network) {
  const sims = network.getPlayerSims(player.name);
  const form = new ActionFormData().title("SIM Manager")
    .button("Insert / switch SIM slot 1")
    .button("Insert SIM slot 2 (dual SIM)")
    .button("Eject slot 1")
    .button("Eject slot 2")
    .button("My SIMs")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 5) return nextForm(() => openPhone(player, network));
    if (res.selection === 2) {
      network.ejectSim(player);
      player.sendMessage("§eSlot 1 ejected");
      return;
    }
    if (res.selection === 3) {
      try { player.setDynamicProperty("carriercore:active_sim2", ""); } catch {}
      player.sendMessage("§eSlot 2 ejected");
      return;
    }
    if (res.selection === 4) {
      if (!sims.length) player.sendMessage("§7No SIMs");
      else for (const sim of sims) {
        const c = network.getCarrier(sim.carrierId);
        player.sendMessage(`§f${sim.number} §7(${c ? c.name : "?"})`);
      }
      return;
    }
    if (!sims.length) return player.sendMessage("§cNo SIMs – create in Terminal.");
    const slot = res.selection === 1 ? 2 : 1;
    nextForm(() => {
      const pick = new ActionFormData().title(`SIM for slot ${slot}`);
      sims.forEach(sim => {
        const c = network.getCarrier(sim.carrierId);
        pick.button(`${sim.number} (${c ? c.name : "?"})`);
      });
      pick.show(player).then((r) => {
        if (r.canceled) return;
        network.setActiveSimSlot(player, sims[r.selection].id, slot);
        player.sendMessage(`§aSlot ${slot}: §f${sims[r.selection].number}`);
      });
    });
  });
}

function openNetworkOps(player, network) {
  const form = new ActionFormData().title("Network Ops")
    .button("Load dashboard")
    .button("Coverage map (chat)")
    .button("Tower maintenance")
    .button("Microwave link (two towers)")
    .button("Emergency broadcast")
    .button("Set DC tier")
    .button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 6) return nextForm(() => openMainTerminal(player, network));
    if (res.selection === 0) {
      const d = network.getLoadDashboard();
      player.sendMessage("§l§b=== Load Dashboard ===");
      for (const t of d.towers) player.sendMessage(`§7Tower ${t.id}: ${t.load}/${t.capacity} ${t.online ? "§aON" : "§cOFF"} ${t.reason || ""}`);
      for (const dc of d.dcs) player.sendMessage(`§7DC ${dc.id} [${dc.tier}]: load ${dc.load} heat ${dc.heat}/${dc.cooling} ${dc.throttled ? "§cTHROTTLED" : "§aOK"}`);
      if (!d.towers.length && !d.dcs.length) player.sendMessage("§7All quiet.");
    } else if (res.selection === 1) {
      const rep = network.getCoverageReport();
      player.sendMessage("§l§b=== Coverage ===");
      for (const t of rep) {
        player.sendMessage(`${t.online ? "§a" : "§c"}● §f${t.id} §7${t.carrier} ${t.tech} r${t.range} @ ${t.x},${t.y},${t.z}${t.maintenance ? " §eMAINT" : ""}`);
      }
      if (!rep.length) player.sendMessage("§7No towers.");
    } else if (res.selection === 2) {
      const towers = Array.from(network.towers.values());
      if (!towers.length) return player.sendMessage("§cNo towers.");
      nextForm(() => {
        const f = new ActionFormData().title("Toggle maintenance");
        towers.forEach(t => f.button(`${t.id} ${t.maintenance ? "[MAINT]" : "[OK]"}`));
        f.show(player).then((r) => {
          if (r.canceled) return;
          const t = towers[r.selection];
          network.setTowerMaintenance(t.id, !t.maintenance);
          player.sendMessage(`§eTower §f${t.id} §7maintenance ${t.maintenance ? "ON" : "OFF"}`);
        });
      });
    } else if (res.selection === 3) {
      const towers = Array.from(network.towers.values());
      if (towers.length < 2) return player.sendMessage("§cNeed 2 towers.");
      nextForm(() => {
        const f1 = new ActionFormData().title("Microwave A"); towers.forEach(t => f1.button(t.id));
        f1.show(player).then((r1) => {
          if (r1.canceled) return;
          nextForm(() => {
            const f2 = new ActionFormData().title("Microwave B"); towers.forEach(t => f2.button(t.id));
            f2.show(player).then((r2) => {
              if (r2.canceled) return;
              const result = network.addMicrowaveLink(towers[r1.selection].id, towers[r2.selection].id);
              if (result.ok) {
                player.sendMessage(`§aMicrowave link §f${result.id} §7(${result.dist}m)`);
                player.sendMessage(`§7A online: ${result.aOnline ? "§aYES" : "§cNO"} §8(${result.aVia || "—"}) §7B online: ${result.bOnline ? "§aYES" : "§cNO"} §8(${result.bVia || "—"})`);
                if (!result.aOnline && !result.bOnline) {
                  player.sendMessage("§eNeither tower has fiber yet – at least one end must have fiber→DC.");
                }
              } else player.sendMessage(`§c${result.reason}`);
            });
          });
        });
      });
    } else if (res.selection === 4) {
      if (network.carriers.size === 0) return player.sendMessage("§cNo carriers.");
      const list = Array.from(network.carriers.values());
      nextForm(() => {
        const f = new ActionFormData().title("Broadcast as"); list.forEach(c => f.button(c.name));
        f.show(player).then((r) => {
          if (r.canceled) return;
          nextForm(() => {
            const modal = new ModalFormData().title("Emergency message").textField("Message", "Service outage in your area");
            modal.show(player).then((mr) => {
              if (mr.canceled) return;
              const n = network.emergencyBroadcast(list[r.selection].id, mr.formValues[0] || "Alert");
              player.sendMessage(`§cBroadcast sent to §f${n} §cSIMs`);
            });
          });
        });
      });
    } else if (res.selection === 5) {
      const dcs = Array.from(network.dataCenters.values());
      if (!dcs.length) return player.sendMessage("§cNo DCs.");
      nextForm(() => {
        const f = new ActionFormData().title("Select DC"); dcs.forEach(d => f.button(`${d.id} [${d.tier || "core"}]`));
        f.show(player).then((r) => {
          if (r.canceled) return;
          nextForm(() => {
            const tf = new ActionFormData().title("Tier").button("Core").button("Regional");
            tf.show(player).then((tr) => {
              if (tr.canceled) return;
              network.setDcTier(dcs[r.selection].id, tr.selection === 1 ? "regional" : "core");
              player.sendMessage(`§aDC §f${dcs[r.selection].id} §7→ ${tr.selection === 1 ? "regional" : "core"}`);
            });
          });
        });
      });
    }
  });
}
