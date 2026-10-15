/**
 * Message creation, queuing, routing and delivery system.
 * This is a stub that will be expanded.
 */

export class MessageSystem {
  constructor(network) {
    this.network = network;
  }

  createMessage(senderSim, recipientNumber, content) {
    const id = `msg_${this.network.nextIds.message++}`;
    const msg = {
      id,
      from: senderSim,
      to: recipientNumber,
      content,
      status: "created",       // created -> uplink -> queued -> routing -> delivered / failed
      createdAt: Date.now(),
      attempts: 0
    };
    this.network.messages.push(msg);
    return msg;
  }

  // Very basic routing stub
  routeMessage(msg) {
    // In full version: look up recipient carrier, find path via peering/IXP, deliver or queue
    msg.status = "queued";
    msg.attempts++;
  }
}
