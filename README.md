# CarrierCore

Minecraft Bedrock addon that simulates a multi-carrier cellular network.

Build towers, register carriers, issue SIMs, send texts, and deal with real failures — overheating data centers, missing backhaul, maintenance windows, the works.

## Requirements

- Minecraft Bedrock **1.26+**
- Experiments: **Beta APIs** (Script API)

## Features (v2.2)

- Multi-carrier networks with peering
- Cell towers (base + BBU + antennas + power + cooling)
- Fiber backhaul and microwave links
- Data centers with heat / cooling simulation
- Dual SIM, messaging, voicemail
- WiFi routers + fiber green boxes
- Satellite dishes & receivers
- Network management terminal
- Phones: generic smartphone, iPhone 17, Galaxy S25, Pixel 10

## Install

1. Download the latest `.mcaddon` from [Releases](../../releases)
2. Open it (Minecraft should import both packs)
3. Enable the Behavior + Resource packs on your world
4. Turn on **Beta APIs** in world experiments

## Building from source

```
BP/CarrierCore_BP/   → Behavior pack
RP/CarrierCore_RP/   → Resource pack
```

Pack both folders into `.mcpack` files, then into a single `.mcaddon`, or just drop the folders into your `development_behavior_packs` / `development_resource_packs` directories while testing.

## Studio

Made by [Blocklogic Studio](https://github.com/blocklogic-studios).

## License

All rights reserved for now. Source is public so people can learn from it and report issues.
