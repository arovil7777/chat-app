import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface RoomInfo {
  room: string;
  users: { id: string; nick: string }[];
}

@WebSocketGateway()
export class ChatGateway {
  @WebSocketServer()
  server: Server;

  connectedClients: Set<string> = new Set();
  clientNickName: Map<string, string> = new Map();
  roomUsers: Map<string, Set<string>> = new Map();
  maxRoomUsers: Map<string, number> = new Map();
  roomCreationCounter: number = 0;

  handleConnection(client: Socket): void {
    // 이미 연결되어 있는 클라이언트인지 확인합니다.
    if (this.connectedClients.has(client.id)) {
      client.disconnect(true); // 이미 연결되어 있는 클라이언트는 연결을 종료합니다.
      return;
    }

    this.connectedClients.add(client.id);
  }

  handleDisconnect(client: Socket): void {
    this.connectedClients.delete(client.id);

    // 클라이언트 연결이 종료되면 해당 클라이언트가 속한 모든 방에서 유저를 제거합니다.
    this.roomUsers.forEach((users, room) => {
      if (users.has(client.id)) {
        users.delete(client.id);

        this.server.to(room).emit('userLeft', {
          userId: this.clientNickName.get(client.id),
          room,
        });
        this.server
          .to(room)
          .emit('userList', { room, userList: this.getUserListWithNick(room) });
      }
    });

    // 연결된 클라이언트 목록을 업데이트하여 emit합니다.
    this.server.emit('userList', {
      room: null,
      userList: this.getUserListWithNick(null),
    });
  }

  @SubscribeMessage('setUserNick')
  handleSetUserNick(client: Socket, nick: string): void {
    this.clientNickName.set(client.id, nick);
  }

  @SubscribeMessage('join')
  handleJoin(client: Socket, room: string): void {
    // 이미 접속 중인 방인지 확인합니다.
    if (client.rooms.has(room)) {
      return;
    }

    // 방에 대한 최대 인원을 확인합니다.
    const maxUsers = this.maxRoomUsers.get(room) || 2; // 기본값으로 방의 최대 인원을 2명으로 설정합니다.

    // 방의 현재 유저 수를 확인합니다.
    const currentUsers = this.roomUsers.get(room)?.size || 0;

    // 방에 대한 최대 인원을 확인하고, 만약 인원이 가득찼다면 새로운 방을 생성합니다.
    if (currentUsers >= maxUsers) {
      if (this.roomCreationCounter >= 2) {
        return;
      }

      const newRoom = this.createRoom(room);
      client.join(newRoom);

      const newRoomUsers = this.roomUsers.get(newRoom) || new Set();
      if (newRoomUsers.size >= maxUsers) {
        return;
      }
      newRoomUsers.add(client.id);
      this.roomUsers.set(newRoom, newRoomUsers);

      this.server.to(newRoom).emit('userJoined', {
        userId: this.clientNickName.get(client.id),
        room: newRoom,
      });
      this.server.to(newRoom).emit('userList', {
        room: newRoom,
        userList: this.getUserListWithNick(newRoom),
      });

      this.server.emit('userList', {
        room: null,
        userList: this.getUserListWithNick(null),
      });
      return;
    }

    client.join(room);

    const roomUsers = this.roomUsers.get(room) || new Set();
    roomUsers.add(client.id);
    this.roomUsers.set(room, roomUsers);

    this.server
      .to(room)
      .emit('userJoined', { userId: this.clientNickName.get(client.id), room });
    this.server
      .to(room)
      .emit('userList', { room, userList: this.getUserListWithNick(room) });

    this.server.emit('userList', {
      room: null,
      userList: this.getUserListWithNick(null),
    });
  }

  createRoom(room: string): string {
    const roomNumber: number = Number(room.match(/\d+/)[0]);
    const newRoom = `room - ${roomNumber + 1}`;

    this.roomCreationCounter++;
    this.server.emit('newRoomCreated', newRoom);
    return newRoom;
  }

  @SubscribeMessage('exit')
  handleExit(client: Socket, room: string): void {
    // 방에 접속되어 있는 상태가 아니라면 return합니다.
    if (!client.rooms.has(room)) {
      return;
    }
    client.leave(room);

    const roomUsers = this.roomUsers.get(room);
    if (roomUsers?.has(client.id)) {
      roomUsers.delete(client.id);

      this.server
        .to(room)
        .emit('userLeft', { userId: this.clientNickName.get(client.id), room });
      this.server
        .to(room)
        .emit('userList', { room, userList: this.getUserListWithNick(room) });
    }

    // 연결된 클라이언트 목록을 업데이트하여 emit합니다.
    this.server.emit('userList', {
      room: null,
      userList: this.getUserListWithNick(null),
    });
  }

  @SubscribeMessage('getUserList')
  handleGetUserList(@ConnectedSocket() client: Socket, room: string): void {
    const roomUsers = this.roomUsers.get(room);
    if (roomUsers) {
      const userListWithNick = this.getUserListWithNick(room);
      this.server
        .to(room)
        .emit('userList', { room, userList: userListWithNick });
    }
  }

  @SubscribeMessage('getCurrentRoomInfo')
  handleGetCurrentRoomInfo(@ConnectedSocket() client: Socket): RoomInfo | null {
    const room = this.getRoomForClient(client);
    if (!room) {
      return null;
    }

    const users = this.getUserListWithNick(room);
    return { room, users };
  }

  @SubscribeMessage('chatMessage')
  handleChatMessage(
    client: Socket,
    data: { message: string; room: string },
  ): void {
    const room = this.getRoomForClient(client);
    if (!room) {
      return;
    }

    // 클라이언트가 보낸 채팅 메시지를 해당 방으로 전달합니다.
    this.server.to(room).emit('chatMessage', {
      userId: this.clientNickName.get(client.id),
      message: data.message,
      room: data.room,
    });
  }

  @SubscribeMessage('typing')
  handleTyping(client: Socket, data: { room: string; user: string }): void {
    const room = this.getRoomForClient(client);
    if (!room) {
      return;
    }

    this.server.to(room).emit('typing', { user: data.user });
  }

  @SubscribeMessage('stopTyping')
  handleStopTyping(client: Socket, room: string): void {
    this.server
      .to(room)
      .emit('stopTyping', { user: this.clientNickName.get(client.id) });
  }

  private getRoomForClient(client: Socket): string | null {
    for (const [room, users] of this.roomUsers.entries()) {
      if (users.has(client.id)) {
        return room;
      }
    }
    return null;
  }

  private getUserListWithNick(
    room: string | null,
  ): { id: string; nick: string }[] {
    const users: { id: string; nick: string }[] = [];
    if (room) {
      const roomUsers = this.roomUsers.get(room);
      roomUsers?.forEach((userId) => {
        users.push({
          id: userId,
          nick: this.clientNickName.get(userId) || 'Unknown',
        });
      });
    } else {
      this.connectedClients.forEach((clientId) => {
        users.push({
          id: clientId,
          nick: this.clientNickName.get(clientId) || 'Unknown',
        });
      });
    }
    return users;
  }
}
