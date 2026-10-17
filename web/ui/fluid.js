/* ============================================================
   Fallen Angels 玻璃皮肤 —— 流体背景（WebGL2）
   ------------------------------------------------------------
   移植自 Beyond Glass / deepseek-harness 的流体壁纸着色器
   （WorkbenchFluid.tsx，经 dsh-beyond-glass 的 fluid-shader.js 提取，
    GLSL 片段逐字保留，只改了宿主接线：帧缓冲尺寸、动画循环、参数注入）。

   为什么用真 WebGL 而不是 CSS 渐变近似：
   · 它的流体是 fbm 噪声 + curl 涡流 + 域扭曲叠出来的，色团边界是"流体褶皱"而不是圆形光斑，
     CSS 那套径向渐变**做不出这个形状**（第一版就是 CSS，一看就不是一个东西）。
   · 顺带白拿鼠标交互 —— 鼠标划过会搅动流体场（这就是着色器里 u_mouse / u_flowmap 那两个
     pass 的用途），CSS 版本完全没有。

   降级策略（三层，代码里逐个兜）：
   ① 没有 WebGL2 → 不加 .has-fluid，退回 themes.css 里那套 CSS 渐变流场
   ② 上下文丢失（webglcontextlost）→ 同样退回 CSS 流场
   ③ 系统开了"减少动态效果" → 只渲染一帧静态画面，不跑动画循环

   性能档位（用户可在设置页或环境检测页切换，见 PERF_TIERS）：
   老机器/核显/远程桌面下流体可能拖慢整个界面，所以给三档手动兜底，
   配合"自动"档的实时掉帧探测 —— 界面卡了会自己降档，不用用户去猜。
   ============================================================ */
(function () {
  "use strict";

  const VERTEX = `#version 300 es
in vec4 a_position;
out vec2 vUv;
void main() {
  vUv = a_position.xy * 0.5 + 0.5;
  gl_Position = a_position;
}
`;

  /* 第一遍：把鼠标轨迹画进一张"流速场"纹理（r=影响强度, gb=方向）。
     每帧只衰减一次、不整体重绘，所以轨迹会留下一段尾巴 —— 这是流体被搅动的手感来源。 */
  const FLOW_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D u_prev;
uniform vec2 u_mouse;
uniform vec2 u_velocity;
uniform float u_brushRadius;
uniform float u_brushStrength;
uniform float u_decay;
out vec4 fragColor;

void main() {
  vec4 prev = texture(u_prev, vUv);

  prev.r *= u_decay;
  prev.gb = mix(vec2(0.5), prev.gb, u_decay);

  float dist = distance(vUv, u_mouse);

  float influence = exp(-dist * dist / (u_brushRadius * u_brushRadius * 0.5));
  influence = max(0.0, influence - 0.01);

  float speed = length(u_velocity);
  float presenceStrength = u_brushStrength * 0.3;
  float velBonus = min(speed * 3.0, 0.7) * u_brushStrength;
  float totalStrength = presenceStrength + velBonus;

  prev.r = max(prev.r, influence * totalStrength);
  float blendAmt = influence * min(totalStrength, 0.4) * 0.3;
  prev.g = mix(prev.g, clamp(u_velocity.x * 2.0 + 0.5, 0.0, 1.0), blendAmt);
  prev.b = mix(prev.b, clamp(u_velocity.y * 2.0 + 0.5, 0.0, 1.0), blendAmt);

  fragColor = prev;
}
`;

  /* 第二遍：拿流速场去扭曲 fbm 噪声场，再把 5 个调色板颜色按噪声值混出来。
     末尾的 grain / bloom / light / vignette 四步是"照片感"的来源，缺一个就会显得很平。 */
  const POST_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_c1, u_c2, u_c3, u_c4, u_c5;
uniform float u_scale;
uniform vec2 u_offset;
uniform float u_grain;
uniform float u_speed;
uniform sampler2D u_flowmap;
uniform float u_distortBoost;
uniform float u_swirlBoost;
uniform float u_glowIntensity;
uniform vec3 u_glowColor1;
uniform vec3 u_glowColor2;
uniform vec3 u_glowColor3;
uniform vec2 u_lightPos;
uniform float u_lightCore;
uniform float u_lightHalo;
uniform float u_vignette;
uniform float u_bloomThreshold;
uniform float u_bloomRange;
uniform float u_bloomStrength;
out vec4 fragColor;

vec3 mod289v3(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289v4(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289v4(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);
  const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289v3(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;
  vec4 s1=floor(b1)*2.+1.;
  vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash(vec2 p){
  vec3 p3=fract(vec3(p.xyx)*.1031);
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}

float fbm(vec3 p){
  float v=0.,amp=.6;vec3 shift=vec3(100.);
  for(int i=0;i<1;i++){v+=amp*snoise(p);p=p*2.+shift;amp*=.4;}
  return v;
}

float fluidNoise(vec2 uv,float t){
  float n1=fbm(vec3(uv*.6,t*.06));
  float n2=fbm(vec3(uv*.6+5.2,t*.06+1.3));
  vec2 w1=vec2(n1,n2)*.6;
  float n3=fbm(vec3((uv+w1)*.7+1.7,t*.05+3.1));
  float n4=fbm(vec3((uv+w1)*.7+9.2,t*.05+5.7));
  vec2 w2=vec2(n3,n4)*.5;
  return fbm(vec3((uv+w1+w2)*.5,t*.04));
}

vec2 curlish(vec2 uv,float t){
  float eps=.02;
  float n=snoise(vec3(uv*.8,t));
  float nx=snoise(vec3((uv+vec2(eps,0.))*.8,t));
  float ny=snoise(vec3((uv+vec2(0.,eps))*.8,t));
  return vec2(-(ny-n)/eps,(nx-n)/eps)*.003;
}

void main(){
  float aspect=u_resolution.x/u_resolution.y;
  vec2 uv=gl_FragCoord.xy/u_resolution;
  vec2 suv=vec2(uv.x*aspect, uv.y) * u_scale + u_offset;
  float t=u_time;

  vec4 flow = texture(u_flowmap, uv);
  float influence = flow.r;
  vec2 flowDir = (flow.gb - 0.5) * 2.0;

  suv += flowDir * influence * u_distortBoost * 0.8;

  float swirlAngle = influence * u_swirlBoost * 2.5;
  float cs = cos(swirlAngle), sn = sin(swirlAngle);
  vec2 delta = suv - vec2(uv.x * aspect, uv.y) * u_scale;
  suv += (mat2(cs, sn, -sn, cs) * delta - delta) * influence;

  vec2 curl=curlish(suv,t*.04);
  vec2 uvD=suv+curl*12.;
  float f=fluidNoise(uvD,t);
  float swirl=snoise(vec3(uvD*.8+f*1.5,t*.035))*.5+.5;
  float n=f*.5+.5;
  vec3 col=mix(u_c1,u_c2,smoothstep(.2,.5,n));
  col=mix(col,u_c3,smoothstep(.35,.65,n+swirl*.25));
  col=mix(col,u_c4,smoothstep(.6,.85,swirl)*.55);
  col=mix(col,u_c5,smoothstep(.5,.8,n*swirl)*.35);

  float glow = smoothstep(0.0, 0.8, influence);
  float glowNoise = snoise(vec3(uvD * 1.5, t * 0.08)) * 0.5 + 0.5;
  float glowDist = smoothstep(0.0, 1.0, influence);
  vec3 glowMix = mix(u_glowColor3, u_glowColor2, glowDist);
  glowMix = mix(glowMix, u_glowColor1, glowDist * glowNoise);
  col = mix(col, glowMix, glow * u_glowIntensity);

  if(u_grain>0.0){
    vec2 flowOffset = (uvD - suv) * u_resolution.y;
    vec2 gp = floor((gl_FragCoord.xy + flowOffset) / 5.0);
    float gr=hash(gp)*2.-1.;
    col+=gr*u_grain;
  }

  float luma=dot(col,vec3(.299,.587,.114));
  float bloom=smoothstep(u_bloomThreshold-u_bloomRange,u_bloomThreshold+u_bloomRange,luma);
  col+=(col*.85+vec3(.15,.145,.13))*bloom*u_bloomStrength;

  float ld=length((uv-u_lightPos)*vec2(aspect,1.));
  float core=exp(-ld*ld*4.5);
  float halo=exp(-ld*1.8);
  col+=vec3(1.,.97,.9)*core*u_lightCore+vec3(.72,.8,1.)*halo*u_lightHalo;

  float vig=1.-smoothstep(.35,.75,length(uv-.5));
  col=mix(col*(1.-u_vignette),col,vig);
  fragColor=vec4(col,1.);
}
`;

  /* 四套调色板：原样抄 dsh-beyond-glass 的 wallpapers.ts 数值，一个都没改。
     每套的 colors 是 5 个色阶（按噪声值依次混入）、glowColors 是鼠标搅动时的辉光三色。 */
  const FLUID_PALETTES = {
    "dark-ocean": {
      colors: ["#000000", "#1A3870", "#204a7e", "#eed8aa", "#000000"],
      glowColors: ["#fff7d1", "#538dca", "#2d448b"],
      params: {
        mouseRadius: 0.09, mouseStrength: 1.8, mouseSmoothing: 0.1, mouseVelocity: 0.2,
        decay: 0.925, distortBoost: 2.2, noiseBoost: 0.3, swirlBoost: 0.8, glowIntensity: 0.13,
        speed: 28, distortion: 18, swirl: 20, swirlIterations: 12, scale: 1.77,
        grain: 0.005, lightX: 0.89, lightY: 0.46, lightCore: 0.14, lightHalo: 0.2,
        vignette: 0.38, bloomThreshold: 0.61, bloomRange: 0.18, bloomStrength: 0.4,
      },
    },
    "aurora": {
      colors: ["#020807", "#063c42", "#0f7168", "#b8ffd9", "#010806"],
      glowColors: ["#d9fff0", "#4be0c1", "#0b6470"],
      params: {
        mouseRadius: 0.09, mouseStrength: 1.8, mouseSmoothing: 0.1, mouseVelocity: 0.2,
        decay: 0.925, distortBoost: 2.2, noiseBoost: 0.3, swirlBoost: 0.8, glowIntensity: 0.16,
        speed: 26, distortion: 18, swirl: 22, swirlIterations: 12, scale: 1.7,
        grain: 0.005, lightX: 0.78, lightY: 0.34, lightCore: 0.13, lightHalo: 0.22,
        vignette: 0.4, bloomThreshold: 0.58, bloomRange: 0.2, bloomStrength: 0.45,
      },
    },
    "amethyst": {
      colors: ["#05020b", "#25115a", "#57318c", "#f0b8ff", "#08020e"],
      glowColors: ["#ffe3ff", "#b46fff", "#552b8d"],
      params: {
        mouseRadius: 0.09, mouseStrength: 1.8, mouseSmoothing: 0.1, mouseVelocity: 0.2,
        decay: 0.93, distortBoost: 2.0, noiseBoost: 0.3, swirlBoost: 0.9, glowIntensity: 0.15,
        speed: 24, distortion: 16, swirl: 24, swirlIterations: 12, scale: 1.62,
        grain: 0.005, lightX: 0.84, lightY: 0.28, lightCore: 0.12, lightHalo: 0.24,
        vignette: 0.36, bloomThreshold: 0.6, bloomRange: 0.18, bloomStrength: 0.42,
      },
    },
    "ember": {
      colors: ["#080201", "#4e130b", "#92361e", "#ffd08a", "#0b0201"],
      glowColors: ["#fff1c4", "#ff8a45", "#7d2618"],
      params: {
        mouseRadius: 0.095, mouseStrength: 2.0, mouseSmoothing: 0.1, mouseVelocity: 0.22,
        decay: 0.92, distortBoost: 2.4, noiseBoost: 0.3, swirlBoost: 0.7, glowIntensity: 0.17,
        speed: 20, distortion: 20, swirl: 14, swirlIterations: 12, scale: 1.85,
        grain: 0.006, lightX: 0.66, lightY: 0.52, lightCore: 0.17, lightHalo: 0.26,
        vignette: 0.42, bloomThreshold: 0.55, bloomRange: 0.22, bloomStrength: 0.5,
      },
    },
  };

  /* ---------- 工具 ---------- */
  function hexToRgb(h) {
    const s = h.replace("#", "");
    const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("着色器编译失败: " + log);
    }
    return sh;
  }

  function makeProgram(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    // 顶点着色器里 in vec4 a_position 不手动绑位置，让 GL 自己分配
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("程序链接失败: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  /** 把 uniform 名收集成一个字典，省得每帧 getUniformLocation */
  function uniforms(gl, prog) {
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (info) u[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return u;
  }

  /* ---------- 性能档位 ----------
     dpr     : 画布分辨率上限（流体是模糊的，超过 1.5 肉眼看不出差别，纯烧 GPU）
     frameMs : 两帧之间的最小间隔（1000/fps）。流体本身很慢，20fps 也看不出顿
     auto 档不写死参数 —— 它按下面 AUTO 那套实时探测的规则动态挑一组。 */
  const PERF_TIERS = {
    high: { dpr: 2.0, frameMs: 33 },     // 高质量：60fps@2x 采样，独显/好核显
    auto: { dpr: 1.5, frameMs: 33 },     // 自动：30fps@1.5x，探测到掉帧就降到 low 的参数
    low: { dpr: 1.0, frameMs: 50 },      // 省电：20fps@1x，老核显/远程桌面/笔记本电池
  };

  /* 自动档的探测规则：
     连续 AUTO_BAD_FRAMES 帧的实际帧间隔都超过 AUTO_SLOW_MS，说明这台机器画不动，
     就地降到 low 档参数（不写配置，下次启动仍从 auto 开始重新判 —— 万一用户
     那会儿只是后台在跑大任务，不该把"这台机器性能差"永久记下来）。 */
  const AUTO_BAD_FRAMES = 45;
  const AUTO_SLOW_MS = 65;

  /* ---------- 主渲染器 ---------- */
  const Fluid = {
    gl: null,
    canvas: null,
    ready: false,
    reduced: false,
    tier: "auto",          // 当前生效档位
    autoDowngraded: false, // 自动档是否已经自己降过（供环境检测页显示）
    palettes: FLUID_PALETTES,
    _raf: 0,
    _current: null,
    _paused: false,
    _slow: 0,

    /** 建 WebGL2 上下文 + 两个程序 + 流速场的 ping-pong 纹理。返回是否成功 */
    init(canvas) {
      if (this.ready) return true;
      this.canvas = canvas;
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
        preserveDrawingBuffer: false,
      });
      if (!gl) return false;
      this.gl = gl;
      try {
        this.flowProg = makeProgram(gl, VERTEX, FLOW_FRAGMENT);
        this.postProg = makeProgram(gl, VERTEX, POST_FRAGMENT);
      } catch (e) {
        return false;
      }
      this.flowU = uniforms(gl, this.flowProg);
      this.postU = uniforms(gl, this.postProg);

      // 一个覆盖全屏的四边形（两个三角形），a_position 用 [-1,1] 的裁剪空间坐标
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

      // 流速场纹理（两张，交替当"上一帧"和"这一帧"，即 ping-pong）
      const W = 256, H = 256;
      this.flowW = W; this.flowH = H;
      this.tex = [0, 1].map(() => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      });
      this.fbo = this.tex.map((t) => {
        const f = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        return f;
      });
      this.cur = 0;

      // 初始流速场：底色是"零影响 + 零方向"（0.0 / 0.5 / 0.5），用一张纯色清掉
      this.clearFlow();

      this.aLoc = gl.getAttribLocation(this.flowProg, "a_position");
      this.aLocPost = gl.getAttribLocation(this.postProg, "a_position");

      // 鼠标状态（归一化到 0..1，和着色器里 vUv 同一坐标系）
      // lastX/lastY 记"上一帧的鼠标位置"，用来算真实速度（见 stepFlow 里的说明）
      this.mouse = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, lastX: 0.5, lastY: 0.5, has: false, active: false, idleAt: 0 };
      this.ready = true;
      return true;
    },

    clearFlow() {
      const gl = this.gl;
      for (let i = 0; i < 2; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
        gl.clearColor(0, 0.5, 0.5, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    resize() {
      if (!this.ready) return;
      // dpr 上限跟档位走（见 PERF_TIERS）。上限 1.5 是背景够用与省 GPU 的折中：
      // 流体本身是模糊的，再高的采样率肉眼看不出来，纯属白烧。
      const cap = (PERF_TIERS[this.tier] || PERF_TIERS.auto).dpr;
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (this.canvas.width === w && this.canvas.height === h) return;
      this.canvas.width = w;
      this.canvas.height = h;
    },

    /** 换性能档位：立刻按新档重设画布分辨率并重启循环（帧率节流在 loop 里读） */
    setTier(tier) {
      // 档位即使在没建上下文时也要记下来 —— 用户可能在普通皮肤下就把档位改了，
      // 之后切到玻璃皮肤才第一次 ensureInited()，那时得用用户选的值，不能回到默认。
      const t = PERF_TIERS[tier] ? tier : "auto";
      if (this.tier === t) return;
      this.tier = t;
      if (!this.ready) return;
      this.canvas.width = 0; this.canvas.height = 0;   // 逼 resize 重算（否则同尺寸会 early-return）
      this.resize();
      if (this._currentName && !this.reduced && !this._paused && !this._raf) this.start(this._currentName);
    },

    setPalette(name) {
      this.palette = this.palettes[name] || this.palettes["dark-ocean"];
      if (!this.ready) return;
      // 换配色时把流速场清掉重新开始，免得上一套的轨迹残影串色
      this.clearFlow();
      this.mouse.active = false;
      this.mouse.x = this.mouse.px = this.mouse.lastX = 0.5;
      this.mouse.y = this.mouse.py = this.mouse.lastY = 0.5;
      this.draw(performance.now());
    },

    /** 鼠标在窗口里的归一化位置（左下为 (0,0)，与 WebGL 纹理坐标一致） */
    onMouse(clientX, clientY) {
      const m = this.mouse;
      m.x = clientX / window.innerWidth;
      m.y = 1 - clientY / window.innerHeight;
      m.has = true;
      m.active = true;
      m.idleAt = performance.now();
    },

    /** 第一遍：更新流速场 */
    stepFlow(dt) {
      const gl = this.gl, p = this.palette.params, m = this.mouse;
      gl.useProgram(this.flowProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - this.cur]);
      gl.viewport(0, 0, this.flowW, this.flowH);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
      gl.uniform1i(this.flowU.u_prev, 0);

      // 鼠标停下超过 1.2 秒就把影响强度放掉，否则一直停留在最后位置留下一个亮斑
      const idle = performance.now() - m.idleAt > 1200;
      if (idle) m.active = false;
      const strength = m.active ? p.mouseStrength : 0;

      // 速度用"每帧位移"而不是"平滑前的差值"：原来拿 m.x - m.px（px 是缓动过的值），
      // 鼠标不动时 m.px 会慢慢追上 m.x，于是每帧都算出一个虚假的小速度，
      // 影响强度永远不会归零 —— 表现为那团亮斑赖着不走。
      const vx = m.x - m.lastX, vy = m.y - m.lastY;
      gl.uniform2f(this.flowU.u_mouse, m.x, m.y);
      gl.uniform2f(this.flowU.u_velocity, vx * p.mouseVelocity * 10, vy * p.mouseVelocity * 10);
      gl.uniform1f(this.flowU.u_brushRadius, p.mouseRadius);
      gl.uniform1f(this.flowU.u_brushStrength, strength);
      gl.uniform1f(this.flowU.u_decay, p.decay);

      this.bindQuad(this.aLoc);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 缓动值只用来算下一次的平滑位置，不参与速度计算
      m.px += (m.x - m.px) * p.mouseSmoothing;
      m.py += (m.y - m.py) * p.mouseSmoothing;
      m.lastX = m.x;
      m.lastY = m.y;

      this.cur = 1 - this.cur;
    },

    /** 第二遍：用流速场渲染最终画面 */
    draw(now) {
      if (!this.ready) return;
      const gl = this.gl, p = this.palette.params;
      this.resize();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      gl.useProgram(this.postProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
      gl.uniform1i(this.postU.u_flowmap, 0);

      const t = now / 1000 * (p.speed / 28);   // speed 参数换算成时间流速
      gl.uniform1f(this.postU.u_time, t);
      gl.uniform2f(this.postU.u_resolution, this.canvas.width, this.canvas.height);

      const c = this.palette.colors, g = this.palette.glowColors;
      gl.uniform3fv(this.postU.u_c1, hexToRgb(c[0]));
      gl.uniform3fv(this.postU.u_c2, hexToRgb(c[1]));
      gl.uniform3fv(this.postU.u_c3, hexToRgb(c[2]));
      gl.uniform3fv(this.postU.u_c4, hexToRgb(c[3]));
      gl.uniform3fv(this.postU.u_c5, hexToRgb(c[4]));
      gl.uniform3fv(this.postU.u_glowColor1, hexToRgb(g[0]));
      gl.uniform3fv(this.postU.u_glowColor2, hexToRgb(g[1]));
      gl.uniform3fv(this.postU.u_glowColor3, hexToRgb(g[2]));

      gl.uniform1f(this.postU.u_scale, p.scale);
      gl.uniform2f(this.postU.u_offset, 0, 0);
      gl.uniform1f(this.postU.u_grain, p.grain);
      gl.uniform1f(this.postU.u_speed, p.speed);
      gl.uniform1f(this.postU.u_distortBoost, p.distortBoost);
      gl.uniform1f(this.postU.u_swirlBoost, p.swirlBoost);
      gl.uniform1f(this.postU.u_glowIntensity, p.glowIntensity);
      gl.uniform2f(this.postU.u_lightPos, p.lightX, p.lightY);
      gl.uniform1f(this.postU.u_lightCore, p.lightCore);
      gl.uniform1f(this.postU.u_lightHalo, p.lightHalo);
      gl.uniform1f(this.postU.u_vignette, p.vignette);
      gl.uniform1f(this.postU.u_bloomThreshold, p.bloomThreshold);
      gl.uniform1f(this.postU.u_bloomRange, p.bloomRange);
      gl.uniform1f(this.postU.u_bloomStrength, p.bloomStrength);

      this.bindQuad(this.aLocPost);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    bindQuad(aLoc) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(aLoc);
      gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    },

    /** 开循环。系统开了"减少动态效果"就只画一帧 */
    start(name) {
      this.setPalette(name);
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.reduced = !!reduce;
      if (reduce) { this.draw(performance.now()); return; }

      cancelAnimationFrame(this._raf);
      this._paused = false;
      this._slow = 0;
      let last = 0;
      let prevTick = 0;     // 上一帧 rAF 的时间戳，用来量"真实帧间隔"
      const loop = (now) => {
        if (this._paused || !this.ready) { this._raf = 0; return; }
        this._raf = requestAnimationFrame(loop);

        /* 自动档掉帧探测。
           ⚠️ 必须用 prevTick 量 rAF 之间的真实间隔，**不能**用 now - last ——
           last 只在"通过节流的那些帧"上更新，正常工作时它恒等于 frameMs（33ms），
           根本反映不出机器画不画得动（踩过：这样写永远测不到掉帧，自降逻辑等于没有）。
           浏览器自己会按 vsync 回调 rAF，所以间隔大于阈值就说明这一帧渲染超时了。 */
        if (this.tier === "auto" && !this.autoDowngraded) {
          const gap = prevTick ? now - prevTick : 0;
          if (gap > AUTO_SLOW_MS) {
            this._slow++;
            if (this._slow >= AUTO_BAD_FRAMES) {
              this.autoDowngraded = true;
              this.canvas.width = 0; this.canvas.height = 0;
              this.resize();
              console.info("[fluid] 检测到持续掉帧，自动降到省电档绘制参数");
            }
          } else { this._slow = 0; }
        }
        prevTick = now;

        // 帧率节流按档位走：普通机器 30fps 足够（流体本身很慢），省电档降到 20fps
        const t = (this.tier === "auto" && this.autoDowngraded) ? PERF_TIERS.low : (PERF_TIERS[this.tier] || PERF_TIERS.auto);
        if (now - last < t.frameMs) return;
        last = now;
        this.stepFlow();
        this.draw(now);
      };
      this._raf = requestAnimationFrame(loop);
    },

    stop() {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    },

    /** 窗口不可见时停循环（后台不烧 GPU），回到前台用同一套配色续上 */
    setPaused(p) {
      this._paused = p;
      if (p) { this.stop(); return; }
      if (this.ready && !this.reduced && !this._raf && this._currentName) this.start(this._currentName);
    },

    /* 退出前彻底收摊：停循环 + 显式释放 WebGL 资源 + 把手里的引用全清掉。
       为什么必须这么做：直接让 Chromium 拆绘图上下文实测会 segfault
       （退出码 139）。停循环只解决"还在画"，纹理/缓冲/程序不手动 delete
       仍然会在上下文销毁时出问题。释放完把 ready 置 false，让任何迟到的
       回调（rAF / resize / pointermove）都直接短路返回。 */
    dispose() {
      this.stop();
      this._paused = true;
      this._currentName = null;
      const gl = this.gl;
      if (gl) {
        try {
          if (this.tex) this.tex.forEach((t) => t && gl.deleteTexture(t));
          if (this.fbo) this.fbo.forEach((f) => f && gl.deleteFramebuffer(f));
          if (this.quad) gl.deleteBuffer(this.quad);
          if (this.flowProg) gl.deleteProgram(this.flowProg);
          if (this.postProg) gl.deleteProgram(this.postProg);
        } catch (e) { /* 上下文可能已经没了，无所谓 */ }
      }
      this.tex = null; this.fbo = null; this.quad = null;
      this.flowProg = null; this.postProg = null;
      this.flowU = null; this.postU = null;
      this.gl = null;
      this.ready = false;
      document.body.classList.remove("has-fluid");
    },
  };

  /* 皮肤 id → 流体调色板名。不是玻璃皮肤就返回 null。 */
  function skinToPalette(skinId) {
    const id = String(skinId || "").replace(/^theme-/, "");
    switch (id) {
      case "dark-glass": return "dark-ocean";
      case "glass-aurora": return "aurora";
      case "glass-amethyst": return "amethyst";
      case "glass-ember": return "ember";
      default: return null;
    }
  }

  /* 真正去建 WebGL 上下文。**只在需要的时候才调** —— 见 applyFluidSkin 的说明。 */
  let booted = false;          // 事件监听/contextlost 只是一次性的，只挂一回
  function ensureInited() {
    if (Fluid.ready) return true;

    const canvas = document.getElementById("fluid-bg");
    if (!canvas) return false;

    if (!booted) {
      booted = true;

      // 文档隐藏时停笔（后台窗口不烧 GPU），回到前台再续上
      document.addEventListener("visibilitychange", () => Fluid.setPaused(document.hidden));
      window.addEventListener("resize", () => { if (Fluid.ready) Fluid.draw(performance.now()); });

      // 上下文丢失（驱动重启/显存不足）时退回 CSS 流场。
      // 挂一次就够，之后重建上下文也用同一个监听。
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        Fluid.ready = false;
        Fluid.stop();
        document.body.classList.remove("has-fluid");
        console.warn("[fluid] WebGL 上下文丢失，退回 CSS 渐变流场");
      });

      // 鼠标搅动：直接听 document，这样面板之间的缝隙也算在内
      document.addEventListener("pointermove", (e) => Fluid.onMouse(e.clientX, e.clientY), { passive: true });
    }

    if (!Fluid.init(canvas)) {
      // 取不到 WebGL2：不加 .has-fluid，CSS 那套渐变流场继续兜底
      console.warn("[fluid] WebGL2 不可用，退回 CSS 渐变流场");
      return false;
    }
    return true;
  }

  /* 对外唯一入口：app.js 切皮肤时调它，fluid.js 启动时也调一次做兜底。
     ⚠️ 这里的顺序很关键：**先判断要不要用流体，再决定建不建上下文**。
     早期版本是一进 boot() 就无条件 `Fluid.init()`（连 WebGL2、编两个着色器、
     建两张 256×256 纹理），然后才看皮肤要不要 —— 导致一辈子用普通主题的用户，
     每次启动都白建一次 GL 上下文、白编译一遍着色器。
     改成惰性初始化后，非玻璃皮肤下连上下文都不存在。 */
  function applyFluidSkin(skinId) {
    const name = skinToPalette(skinId);
    Fluid._currentName = name;

    if (!name) {
      // 离开玻璃皮肤：停循环 + 摘掉 .has-fluid，别在别的皮肤下白烧 GPU。
      // 上下文刻意**不销毁** —— 用户来回切皮肤时省掉重建开销；
      // 它不画任何帧，占的显存可忽略，真正释放交给退出前的 dispose()。
      Fluid.stop();
      document.body.classList.remove("has-fluid");
      return false;
    }

    if (!ensureInited()) return false;   // WebGL 起不来，交给 CSS 兜底渐变

    document.body.classList.add("has-fluid");
    Fluid.start(name);
    return true;
  }

  function boot() {
    if (!document.getElementById("fluid-bg")) return;

    // 只读一次当前皮肤，交给 applyFluidSkin 判断 ——
    // 是玻璃皮肤它才会去 ensureInited()，否则这一步就结束了。
    // ⚠️ body.className 必须在任何 setPalette 之前读（init 里的会重建流速场）。
    applyFluidSkin(document.body.className);

    // 全局入口始终要挂（即使当前是普通皮肤、上下文压根没建）：
    // 不挂的话后面切到玻璃皮肤时，app.js 里 `window.__fluid && window.__fluid.setSkin`
    // 这个判断不成立，流体永远起不来。
    window.__fluid = {
      setSkin: applyFluidSkin,
      dispose: () => Fluid.dispose(),
      // 性能档位：设置页/检测页读写它。setTier 立即生效，不必等下次启动。
      setTier: (t) => Fluid.setTier(t),
      get tier() { return Fluid.tier; },
      get autoDowngraded() { return Fluid.autoDowngraded; },
      get ready() { return Fluid.ready; },
      get palette() { return Fluid._currentName; },
      // 只读快照，给验证脚本判断"鼠标事件到底进来没有"。
      // 不直接暴露 Fluid 本体，免得脚本拿到手乱改内部状态。
      get mouse() {
        const m = Fluid.mouse;
        return m ? { x: Math.round(m.x * 100) / 100, y: Math.round(m.y * 100) / 100, has: m.has, active: m.active } : null;
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
