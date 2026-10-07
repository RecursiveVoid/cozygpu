/**
 * WebGL2 enum values as plain top-level constants.
 *
 * Numeric literals instead of `gl.TEXTURE_2D` lookups: the minifier inlines
 * them, they exist in Node tests (no WebGL2RenderingContext global), and they
 * stay valid on a lost context. `examples/basic/?mode=glcheck` compares every
 * value against a real context.
 */

// Clear bits, primitives
export const DEPTH_BUFFER_BIT = 0x0100;
export const STENCIL_BUFFER_BIT = 0x0400;
export const COLOR_BUFFER_BIT = 0x4000;
export const POINTS = 0x0000;
export const LINES = 0x0001;
export const TRIANGLES = 0x0004;
export const TRIANGLE_STRIP = 0x0005;

// Blend factors
export const ONE = 0x0001;
export const ONE_MINUS_SRC_COLOR = 0x0301;
export const ONE_MINUS_SRC_ALPHA = 0x0303;
export const DST_COLOR = 0x0306;

// Capabilities (enable/disable)
export const BLEND = 0x0be2;
export const DEPTH_TEST = 0x0b71;
export const SCISSOR_TEST = 0x0c11;
export const RASTERIZER_DISCARD = 0x8c89;
export const CULL_FACE = 0x0b44;
export const STENCIL_TEST = 0x0b90;

// Compare functions (CompareFunction) and stencil operations (M3, masks)
export const NEVER = 0x0200;
export const LESS = 0x0201;
export const EQUAL = 0x0202;
export const LEQUAL = 0x0203;
export const GREATER = 0x0204;
export const NOTEQUAL = 0x0205;
export const GEQUAL = 0x0206;
export const ALWAYS = 0x0207;
export const KEEP = 0x1e00;
export const REPLACE = 0x1e01;
export const INCR = 0x1e02;
export const DECR = 0x1e03;
export const INVERT = 0x150a;
export const INCR_WRAP = 0x8507;
export const DECR_WRAP = 0x8508;
export const ZERO = 0x0000;

// Buffers
export const ARRAY_BUFFER = 0x8892;
export const ELEMENT_ARRAY_BUFFER = 0x8893;
export const UNIFORM_BUFFER = 0x8a11;
export const COPY_READ_BUFFER = 0x8f36;
export const COPY_WRITE_BUFFER = 0x8f37;
export const PIXEL_PACK_BUFFER = 0x88eb;
export const PIXEL_UNPACK_BUFFER = 0x88ec;
export const TRANSFORM_FEEDBACK_BUFFER = 0x8c8e;
export const TRANSFORM_FEEDBACK = 0x8e22;
export const DYNAMIC_DRAW = 0x88e8;
/**
 * GL_STREAM_COPY, the usage hint of every pack buffer in a readback ring.
 *
 * A `*_READ` hint makes Chrome keep a client-side shadow copy of the buffer to
 * accelerate the readback, on the assumption that the buffer is filled once
 * and then read once. A ring deliberately refills the same buffer every read,
 * so the shadow is thrown away each time and Chrome logs "READ-usage buffer
 * was written, then fenced, but written again before being read back" once per
 * read. Measured over 40 reads on Chrome 153 / ANGLE Metal, the hint changes
 * nothing else: getBufferSubData p50 0.115 ms with STREAM_COPY against
 * 0.110 ms with STREAM_READ, same end-to-end latency, no warnings.
 */
export const STREAM_COPY = 0x88e2;
export const INTERLEAVED_ATTRIBS = 0x8c8c;

// Data types
export const UNSIGNED_BYTE = 0x1401;
export const UNSIGNED_SHORT = 0x1403;
export const INT = 0x1404;
export const UNSIGNED_INT = 0x1405;
export const FLOAT = 0x1406;
export const HALF_FLOAT = 0x140b;
export const UNSIGNED_INT_24_8 = 0x84fa;

// Pixel formats
export const DEPTH_COMPONENT = 0x1902;
export const RED = 0x1903;
export const RGBA = 0x1908;
export const RG = 0x8227;
export const RED_INTEGER = 0x8d94;
export const RG_INTEGER = 0x8228;
export const RGBA_INTEGER = 0x8d99;
export const DEPTH_STENCIL = 0x84f9;

// Sized internal formats
export const RGBA8 = 0x8058;
export const SRGB8_ALPHA8 = 0x8c43;
export const R8 = 0x8229;
export const RGBA16F = 0x881a;
export const RGBA32F = 0x8814;
export const R32UI = 0x8236;
export const RG32UI = 0x823c;
export const RGBA32UI = 0x8d70;
export const DEPTH_COMPONENT24 = 0x81a6;
export const DEPTH24_STENCIL8 = 0x88f0;
export const DEPTH_COMPONENT32F = 0x8cac;

// Compressed internal formats (extensions)
export const COMPRESSED_RGBA_S3TC_DXT1_EXT = 0x83f1;
export const COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83f3;
export const COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT = 0x8c4d;
export const COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT = 0x8c4f;
export const COMPRESSED_RED_RGTC1_EXT = 0x8dbb;
export const COMPRESSED_RED_GREEN_RGTC2_EXT = 0x8dbd;
export const COMPRESSED_RGBA_BPTC_UNORM_EXT = 0x8e8c;
export const COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT = 0x8e8d;
export const COMPRESSED_R11_EAC = 0x9270;
export const COMPRESSED_RG11_EAC = 0x9272;
export const COMPRESSED_RGB8_ETC2 = 0x9274;
export const COMPRESSED_SRGB8_ETC2 = 0x9275;
export const COMPRESSED_RGBA8_ETC2_EAC = 0x9278;
export const COMPRESSED_SRGB8_ALPHA8_ETC2_EAC = 0x9279;
export const COMPRESSED_RGBA_ASTC_4x4_KHR = 0x93b0;
export const COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR = 0x93d0;

// Textures and samplers
export const TEXTURE_2D = 0x0de1;
export const TEXTURE0 = 0x84c0;
export const TEXTURE_MAG_FILTER = 0x2800;
export const TEXTURE_MIN_FILTER = 0x2801;
export const TEXTURE_WRAP_S = 0x2802;
export const TEXTURE_WRAP_T = 0x2803;
export const NEAREST = 0x2600;
export const LINEAR = 0x2601;
export const NEAREST_MIPMAP_NEAREST = 0x2700;
export const LINEAR_MIPMAP_NEAREST = 0x2701;
export const NEAREST_MIPMAP_LINEAR = 0x2702;
export const LINEAR_MIPMAP_LINEAR = 0x2703;
export const REPEAT = 0x2901;
export const CLAMP_TO_EDGE = 0x812f;
export const MIRRORED_REPEAT = 0x8370;

// Framebuffers
export const FRAMEBUFFER = 0x8d40;
export const READ_FRAMEBUFFER = 0x8ca8;
export const DRAW_FRAMEBUFFER = 0x8ca9;
export const RENDERBUFFER = 0x8d41;
export const COLOR_ATTACHMENT0 = 0x8ce0;
export const DEPTH_ATTACHMENT = 0x8d00;
export const DEPTH_STENCIL_ATTACHMENT = 0x821a;
export const COLOR = 0x1800;

// Pixel store
export const UNPACK_ALIGNMENT = 0x0cf5;
export const PACK_ALIGNMENT = 0x0d05;
export const UNPACK_FLIP_Y_WEBGL = 0x9240;
export const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
export const UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243;

// Programs
export const FRAGMENT_SHADER = 0x8b30;
export const VERTEX_SHADER = 0x8b31;
export const COMPILE_STATUS = 0x8b81;
export const LINK_STATUS = 0x8b82;
export const COMPLETION_STATUS_KHR = 0x91b1;
export const INVALID_INDEX = 0xffffffff;

// Sync objects
export const SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
export const ALREADY_SIGNALED = 0x911a;
export const TIMEOUT_EXPIRED = 0x911b;
export const CONDITION_SATISFIED = 0x911c;
export const WAIT_FAILED = 0x911d;

// Limits
export const MAX_TEXTURE_SIZE = 0x0d33;
export const MAX_TEXTURE_IMAGE_UNITS = 0x8872;
export const MAX_UNIFORM_BLOCK_SIZE = 0x8a30;
export const MAX_SAMPLES = 0x8d57;

// Active uniform / varying types (transform feedback record sizes)
export const FLOAT_VEC2 = 0x8b50;
export const FLOAT_VEC3 = 0x8b51;
export const FLOAT_VEC4 = 0x8b52;
export const INT_VEC2 = 0x8b53;
export const INT_VEC3 = 0x8b54;
export const INT_VEC4 = 0x8b55;
export const UNSIGNED_INT_VEC2 = 0x8dc6;
export const UNSIGNED_INT_VEC3 = 0x8dc7;
export const UNSIGNED_INT_VEC4 = 0x8dc8;
export const FLOAT_MAT2 = 0x8b5a;
export const FLOAT_MAT3 = 0x8b5b;
export const FLOAT_MAT4 = 0x8b5c;
