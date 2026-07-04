let socketServer = null;

export const setSocketServer = (io) => {
  socketServer = io;
};

export const notificationRoom = (userId) => `notification_${userId}`;

export const emitToUser = (userId, event, payload) => {
  if (!socketServer || !userId) return;
  socketServer.to(notificationRoom(userId)).emit(event, payload);
};
