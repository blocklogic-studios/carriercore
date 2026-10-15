export function registerAllComponents(registry) {
  registry.registerCustomComponent("carriercore:tower_base", {
    onPlayerInteract(event) {
      if (event.player) event.player.sendMessage("§8[Tower Base] Use Terminal to register when fully built.");
    }
  });
  registry.registerCustomComponent("carriercore:antenna", {
    onPlayerInteract(event) {
      if (event.player) event.player.sendMessage("§8[Antenna] Place near tower server rack (BBU).");
    }
  });
  registry.registerCustomComponent("carriercore:server_rack", {
    onPlayerInteract(event) {
      if (event.player) event.player.sendMessage("§8[Server Rack] Tower BBU or DC processing.");
    }
  });
  // Router/dish/green box/receiver: menus via playerInteractWithBlock in handlers
  registry.registerCustomComponent("carriercore:wifi_router", { onPlayerInteract() {} });
  registry.registerCustomComponent("carriercore:green_box", { onPlayerInteract() {} });
  registry.registerCustomComponent("carriercore:satellite_dish", { onPlayerInteract() {} });
  registry.registerCustomComponent("carriercore:sat_receiver", { onPlayerInteract() {} });
}
