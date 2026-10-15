import { system, world } from "@minecraft/server";
import { registerAllComponents } from "./core/components.js";
import { NetworkManager } from "./core/NetworkManager.js";
import { setupUIHandlers } from "./ui/handlers.js";

export const network = new NetworkManager();

system.beforeEvents.startup.subscribe((event) => {
  registerAllComponents(event.blockComponentRegistry);
  console.log("[CarrierCore] Components registered");
});

world.afterEvents.worldLoad.subscribe(() => {
  network.load();
  setupUIHandlers(network);

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    try {
      const perm = event.brokenBlockPermutation;
      const typeId = perm && perm.type ? perm.type.id : null;
      const b = event.block;
      if (typeId === "carriercore:tower_base") {
        const removed = network.deregisterTowerAt(b.x, b.y, b.z, event.player?.dimension?.id);
        if (removed && event.player) {
          event.player.sendMessage(`§eTower §f${removed.id} §7deregistered (base destroyed).`);
        }
        return;
      }
      const gear = [
        "carriercore:wifi_router",
        "carriercore:green_box",
        "carriercore:satellite_dish",
        "carriercore:sat_receiver"
      ];
      if (gear.includes(typeId)) {
        const r = network.deregisterAt(b.x, b.y, b.z);
        if (r && event.player) {
          event.player.sendMessage(`§eRemoved registered ${r.type} §f${r.id}`);
        }
      }
    } catch (e) {
      console.warn("[CarrierCore] break handler:", e);
    }
  });

  console.log("[CarrierCore] Network loaded and UI ready");
});

system.runInterval(() => {
  network.tick();
}, 20);

console.log("[CarrierCore] Multi-carrier telecom system started");
