/**
 * Binary command decoder (docs/ARCHITECTURE.md §3.6).
 *
 * `reset()` validates the whole packet (magic, lengths, every command end,
 * command count) before anything executes, so a corrupted packet is dropped
 * as a unit. Views are cached per buffer in a small LRU (VIEW_CACHE_SIZE
 * entries): in main-thread mode the same ArrayBuffer comes back every frame,
 * and in worker ring mode (ARCHITECTURE §17) the SharedArrayBuffer slots
 * alternate, so steady-state decoding allocates nothing. On the worker
 * transfer path each transferred buffer is a new object, which costs three
 * view objects per packet (the structured clone allocates far more anyway).
 */
import { CozyGPUError } from '../types/errors';
import type {
  CommandDecoder,
  CommandReader,
  FramePacket,
  PacketObject,
} from './types';
import {
  CH_PAYLOAD_BYTES,
  COMMAND_HEADER_BYTES,
  PACKET_HEADER_BYTES,
  PACKET_MAGIC,
  PH_BYTE_LENGTH,
  PH_COMMAND_COUNT,
  PH_FRAME_ID,
  PH_MAGIC,
} from './opcodes';
import { align4, sharedTextDecoder } from './utf8';

const EMPTY_OBJECTS: PacketObject[] = [];
const EMPTY_BUFFER = new ArrayBuffer(0);

/** Buffers whose views stay cached (ring slots + the transfer-path pool). */
export const VIEW_CACHE_SIZE = 4;

type PacketBuffer = ArrayBuffer | SharedArrayBuffer;

export class CommandReaderImpl implements CommandReader {
  public opcode = 0;
  public flags = 0;
  public commandOffset = 0;
  public payloadOffset = 0;
  public payloadBytes = 0;
  public u8 = new Uint8Array(EMPTY_BUFFER);
  public u32View = new Uint32Array(EMPTY_BUFFER);
  public f32View = new Float32Array(EMPTY_BUFFER);

  /** @internal */
  public cursor = 0;
  /** @internal End of the current payload. */
  public end = 0;
  /** @internal */
  public objects: PacketObject[] = EMPTY_OBJECTS;

  u32(): number {
    const c = this.cursor;
    if (c + 4 > this.end) this.overflow(4);
    this.cursor = c + 4;
    return this.u32View[c >> 2];
  }

  i32(): number {
    const c = this.cursor;
    if (c + 4 > this.end) this.overflow(4);
    this.cursor = c + 4;
    return this.u32View[c >> 2] | 0;
  }

  f32(): number {
    const c = this.cursor;
    if (c + 4 > this.end) this.overflow(4);
    this.cursor = c + 4;
    return this.f32View[c >> 2];
  }

  blob(byteLength: number): number {
    const c = this.cursor;
    // Bounds-check before aligning: align4 uses 32-bit ops and wraps for
    // lengths >= 2^31 - 3 (a corrupt u32 count times a record size).
    if (!(byteLength >= 0 && byteLength <= this.end - c)) {
      this.overflow(byteLength);
    }
    const padded = align4(byteLength);
    if (c + padded > this.end) this.overflow(padded);
    this.cursor = c + padded;
    return c;
  }

  utf8(byteLength: number): string {
    const at = this.blob(byteLength);
    const u8 = this.u8;
    // TextDecoder rejects views over a SharedArrayBuffer (ring slots): copy.
    // Rare commands only (SWARM_CREATE), so the copy is acceptable.
    const view =
      u8.buffer instanceof ArrayBuffer
        ? u8.subarray(at, at + byteLength)
        : u8.slice(at, at + byteLength);
    return sharedTextDecoder().decode(view);
  }

  skip(byteLength: number): void {
    this.blob(byteLength);
  }

  object<T extends PacketObject>(index: number): T {
    const obj = this.objects[index];
    if (obj === undefined) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `command 0x${this.opcode.toString(16)} references missing packet object ${index}`,
      );
    }
    return obj as T;
  }

  private overflow(bytes: number): never {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `command 0x${this.opcode.toString(16)}: read past its payload`,
    );
  }
}

export class CommandDecoderImpl implements CommandDecoder {
  public frameId = 0;
  public commandCount = 0;
  public readonly reader = new CommandReaderImpl();

  private buffer: PacketBuffer = EMPTY_BUFFER;
  private byteLength = 0;
  /** Offset of the next command header. */
  private nextOffset = 0;

  /** View cache: parallel arrays, most recently used first. */
  private readonly cacheBuffers: (PacketBuffer | null)[] = [];
  private readonly cacheU8: Uint8Array<ArrayBuffer>[] = [];
  private readonly cacheU32: Uint32Array<ArrayBuffer>[] = [];
  private readonly cacheF32: Float32Array<ArrayBuffer>[] = [];

  constructor() {
    const r = this.reader;
    for (let i = 0; i < VIEW_CACHE_SIZE; i++) {
      this.cacheBuffers.push(null);
      this.cacheU8.push(r.u8);
      this.cacheU32.push(r.u32View);
      this.cacheF32.push(r.f32View);
    }
  }

  reset(packet: FramePacket): void {
    const buffer = packet.buffer;
    const r = this.reader;
    if (
      buffer !== this.buffer ||
      r.u8.byteLength !== buffer.byteLength ||
      buffer.byteLength < PACKET_HEADER_BYTES
    ) {
      if (
        buffer.byteLength < PACKET_HEADER_BYTES ||
        (buffer.byteLength & 3) !== 0
      ) {
        this.invalidate();
        corrupt(`packet buffer detached or unaligned (${buffer.byteLength} B)`);
      }
      this.useViews(buffer);
    }
    r.objects = packet.objects ?? EMPTY_OBJECTS;

    const u32 = r.u32View;
    if (u32[PH_MAGIC >> 2] !== PACKET_MAGIC) {
      this.invalidate();
      corrupt(`bad packet magic 0x${u32[PH_MAGIC >> 2].toString(16)}`);
    }
    const byteLength = u32[PH_BYTE_LENGTH >> 2];
    if (
      byteLength < PACKET_HEADER_BYTES ||
      byteLength > buffer.byteLength ||
      (byteLength & 3) !== 0
    ) {
      this.invalidate();
      corrupt(
        `bad packet byteLength ${byteLength} (buffer ${buffer.byteLength} B)`,
      );
    }
    const commandCount = u32[PH_COMMAND_COUNT >> 2];

    // Validation pass: header hops only.
    let offset = PACKET_HEADER_BYTES;
    let count = 0;
    while (offset < byteLength) {
      if (offset + COMMAND_HEADER_BYTES > byteLength) {
        this.invalidate();
        corrupt(`truncated command header at ${offset}`);
      }
      const payloadBytes = u32[(offset + CH_PAYLOAD_BYTES) >> 2];
      const end = offset + COMMAND_HEADER_BYTES + payloadBytes;
      if ((payloadBytes & 3) !== 0 || end > byteLength) {
        this.invalidate();
        corrupt(`command at ${offset} has bad payloadBytes ${payloadBytes}`);
      }
      offset = end;
      count++;
    }
    if (count !== commandCount) {
      this.invalidate();
      corrupt(`packet declares ${commandCount} commands but contains ${count}`);
    }

    this.byteLength = byteLength;
    this.frameId = u32[PH_FRAME_ID >> 2];
    this.commandCount = commandCount;
    this.nextOffset = PACKET_HEADER_BYTES;
    r.opcode = 0;
    r.flags = 0;
    r.commandOffset = 0;
    r.payloadOffset = 0;
    r.payloadBytes = 0;
    r.cursor = 0;
    r.end = 0;
  }

  next(): boolean {
    if (this.nextOffset >= this.byteLength) return false;
    this.load(this.nextOffset);
    return true;
  }

  /**
   * Positions the reader ON the command at `commandOffset` (a value previously
   * read from `reader.commandOffset`) with its cursor at the payload start.
   * A following `next()` continues with the command after it.
   *
   * O(1): the offset is not proven to be a command boundary, but the header
   * found there must describe a payload that ends inside the packet, so reads
   * stay bounded by `byteLength` even for a bogus (aligned) offset.
   */
  seek(commandOffset: number): void {
    const byteLength = this.byteLength;
    if (
      !(commandOffset >= PACKET_HEADER_BYTES) ||
      commandOffset + COMMAND_HEADER_BYTES > byteLength ||
      (commandOffset & 3) !== 0
    ) {
      corrupt(`seek to invalid command offset ${commandOffset}`);
    }
    const payloadBytes =
      this.reader.u32View[(commandOffset + CH_PAYLOAD_BYTES) >> 2];
    if (
      (payloadBytes & 3) !== 0 ||
      payloadBytes > byteLength - commandOffset - COMMAND_HEADER_BYTES
    ) {
      corrupt(`seek to ${commandOffset}: payload runs past the packet`);
    }
    this.load(commandOffset);
  }

  private load(offset: number): void {
    const r = this.reader;
    const u32 = r.u32View;
    const word = u32[offset >> 2];
    const payloadBytes = u32[(offset + CH_PAYLOAD_BYTES) >> 2];
    const payloadOffset = offset + COMMAND_HEADER_BYTES;
    r.opcode = word & 0xffff;
    r.flags = word >>> 16;
    r.commandOffset = offset;
    r.payloadOffset = payloadOffset;
    r.payloadBytes = payloadBytes;
    r.cursor = payloadOffset;
    r.end = payloadOffset + payloadBytes;
    this.nextOffset = r.end;
  }

  /** Points the reader at cached views of `buffer`, creating them on a miss. */
  private useViews(buffer: PacketBuffer): void {
    const r = this.reader;
    const buffers = this.cacheBuffers;
    const n = buffers.length;
    let hit = -1;
    for (let i = 0; i < n; i++) {
      if (
        buffers[i] === buffer &&
        this.cacheU8[i].byteLength === buffer.byteLength
      ) {
        hit = i;
        break;
      }
    }
    let u8: Uint8Array<ArrayBuffer>;
    let u32: Uint32Array<ArrayBuffer>;
    let f32: Float32Array<ArrayBuffer>;
    if (hit >= 0) {
      u8 = this.cacheU8[hit];
      u32 = this.cacheU32[hit];
      f32 = this.cacheF32[hit];
    } else {
      hit = n - 1; // evict the least recently used entry
      // A SharedArrayBuffer slot is typed as ArrayBuffer for the views.
      u8 = new Uint8Array(buffer as ArrayBuffer);
      u32 = new Uint32Array(buffer as ArrayBuffer);
      f32 = new Float32Array(buffer as ArrayBuffer);
    }
    // Move to the front (shift entries 0..hit-1 down by one).
    for (let i = hit; i > 0; i--) {
      buffers[i] = buffers[i - 1];
      this.cacheU8[i] = this.cacheU8[i - 1];
      this.cacheU32[i] = this.cacheU32[i - 1];
      this.cacheF32[i] = this.cacheF32[i - 1];
    }
    buffers[0] = buffer;
    this.cacheU8[0] = u8;
    this.cacheU32[0] = u32;
    this.cacheF32[0] = f32;
    this.buffer = buffer;
    r.u8 = u8;
    r.u32View = u32;
    r.f32View = f32;
  }

  private invalidate(): void {
    this.byteLength = 0;
    this.nextOffset = 0;
    this.commandCount = 0;
  }
}

function corrupt(message: string): never {
  throw new CozyGPUError(
    'INVALID_ARGUMENT',
    `corrupt command packet: ${message}`,
  );
}
