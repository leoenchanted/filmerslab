// ═══════════════════════════════════════════════════════════════════
//  glRenderer.js
//  WebGL2 初始化、Shader 编译、纹理上传、渲染调用
// ═══════════════════════════════════════════════════════════════════

// ── Vertex Shader ────────────────────────────────────────────────
const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}`;

// ── Fragment Shader ──────────────────────────────────────────────
// 物理正确的负片转正流程（密度域操作）
const FS = `#version 300 es
precision highp float;

uniform sampler2D u_tex;

// 密度域参数（由 CPU 分析得出）
uniform vec3  u_baseDensity;   // 色罩基底密度 = -ln(maskRGB)
uniform vec3  u_densityScale;  // 密度归一化缩放（等价于 Levels 白场）
uniform mat3  u_crossMat;      // CMY 染料串扰校正矩阵

// 用户调节参数
uniform vec3  u_wb;     // 白平衡增益 (R/G/B 乘数)
uniform float u_gamma;  // 胶片特性曲线 Gamma
uniform float u_exp;    // 曝光补偿 (EV)
uniform float u_con;    // 对比度
uniform float u_temp;   // 色温偏移
uniform float u_tint;   // 色调偏移
uniform float u_sat;    // 饱和度

in  vec2 v_uv;
out vec4 fragColor;

// sRGB 编码（线性 → 显示器）
vec3 toSRGB(vec3 c) {
  return mix(
    12.92 * c,
    1.055 * pow(clamp(c, 0.0, 1.0), vec3(1.0/2.4)) - 0.055,
    step(0.0031308, c)
  );
}

void main() {
  // ① 读入扫描像素，钳制防止 log(0)
  vec3 raw = clamp(texture(u_tex, v_uv).rgb, 0.001, 0.999);

  // ② 转换到光学密度域: D = -ln(透过率)
  //    密度越大 → 底片越不透明 → 对应正片越暗
  vec3 D = -log(raw);

  // ③ 减去色罩基底密度（Orange Mask Subtraction）
  //    关键：必须在密度域相减，线性域做除法是物理错误的
  vec3 Dcorr = max(D - u_baseDensity, 0.0);

  // ④ CMY 染料串扰校正
  //    彩色负片的 C/M/Y 三层染料在 RGB 三通道都有吸收重叠
  //    矩阵将各通道解耦，让颜色更纯正
  vec3 Dfix = u_crossMat * Dcorr;
  Dfix = max(Dfix, 0.0);

  // ⑤ 密度缩放归一化（= Levels 拉伸）
  vec3 c = clamp(Dfix * u_densityScale, 0.0, 1.0);

  // ⑥ 胶片特性曲线 Gamma
  //    模拟真实胶片 H&D 曲线的趾部（toe）压缩特性
  //    提亮暗部、软化高光过渡
  c = pow(c, vec3(1.0 / u_gamma));

  // ⑦ 白平衡增益（按通道乘数）
  c *= u_wb;

  // ⑧ 色温 & 色调（在线性域加法微调）
  c.r += u_temp * 0.008;
  c.b -= u_temp * 0.008;
  c.g += u_tint * 0.008;

  // ⑨ 曝光补偿（EV = 2 的幂次，物理上正确的乘法）
  c *= pow(2.0, u_exp);

  // ⑩ S 形对比度（围绕 0.5 的线性拉伸）
  c = (c - 0.5) * u_con + 0.5;

  // ⑪ 饱和度（使用 Rec.709 亮度系数）
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, u_sat);

  // ⑫ sRGB 编码输出
  fragColor = vec4(clamp(toSRGB(c), 0.0, 1.0), 1.0);
}`;

// ── Compile Helper ───────────────────────────────────────────────
function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[Shader Error]', gl.getShaderInfoLog(s));
  }
  return s;
}

// ── GLRenderer Class ─────────────────────────────────────────────
export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: false
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this._initProgram();
    this._initGeometry();
    this._initTexture();
    this._cacheUniforms();
  }

  _initProgram() {
    const { gl } = this;
    this.prog = gl.createProgram();
    gl.attachShader(this.prog, compileShader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, compileShader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) {
      console.error('[Link Error]', gl.getProgramInfoLog(this.prog));
    }
  }

  _initGeometry() {
    const { gl, prog } = this;

    // 全屏四边形顶点
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1,  1,-1,  -1,1,  1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // UV（垂直翻转以匹配图像坐标）
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([0,1,  1,1,  0,0,  1,0]), gl.STATIC_DRAW);
    const aUV = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  }

  _initTexture() {
    const { gl } = this;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  _cacheUniforms() {
    const { gl, prog } = this;
    const names = [
      'u_tex', 'u_baseDensity', 'u_densityScale', 'u_crossMat',
      'u_wb', 'u_gamma', 'u_exp', 'u_con', 'u_temp', 'u_tint', 'u_sat'
    ];
    this.U = {};
    names.forEach(n => { this.U[n] = gl.getUniformLocation(prog, n); });
  }

  /** 上传图片到 GPU 纹理，同时更新 canvas 尺寸 */
  uploadImage(img) {
    const { gl, canvas, tex } = this;
    let w = img.width, h = img.height;
    if (Math.max(w, h) > 4096) {
      const s = 4096 / Math.max(w, h);
      w = (w * s) | 0; h = (h * s) | 0;
    }
    canvas.width = w; canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }

  /**
   * 渲染一帧
   * @param {object} params - 所有 shader uniform 参数
   *   params.maskAdj      - [R,G,B] 色罩绝对值（直接来自滑块，无需乘法）
   *   params.densityScale - [R,G,B]
   *   params.crossMat     - Float32Array(9) 列主序
   *   params.wb           - [R,G,B]
   *   params.gamma        - number
   *   params.exp          - number
   *   params.con          - number
   *   params.temp         - number
   *   params.tint         - number
   *   params.sat          - number
   */
  render(params) {
    const { gl, prog, tex, canvas, U } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(U.u_tex, 0);

    // 色罩基底密度：直接从 maskAdj 计算，不做额外乘法
    const { maskAdj } = params;
    const baseDensity = maskAdj.map(m => -Math.log(Math.max(m, 0.001)));
    gl.uniform3fv(U.u_baseDensity,   baseDensity);
    gl.uniform3fv(U.u_densityScale,  params.densityScale);
    gl.uniformMatrix3fv(U.u_crossMat, false, params.crossMat);
    gl.uniform3fv(U.u_wb,            params.wb);
    gl.uniform1f(U.u_gamma,          params.gamma);
    gl.uniform1f(U.u_exp,            params.exp);
    gl.uniform1f(U.u_con,            params.con);
    gl.uniform1f(U.u_temp,           params.temp);
    gl.uniform1f(U.u_tint,           params.tint);
    gl.uniform1f(U.u_sat,            params.sat);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** 导出当前帧为 JPEG dataURL */
  exportJPEG(quality = 0.95) {
    return this.canvas.toDataURL('image/jpeg', quality);
  }

  /** 读取当前帧像素（用于直方图） */
  readPixels(w, h) {
    const buf = new Uint8Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, buf);
    return buf;
  }
}
