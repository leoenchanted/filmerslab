# FilmLab Pro 代码解说

这是一份对 `filmlab` 目录下源码的结构化说明，聚焦负片转正的流程、核心算法与模块职责，方便二次开发与维护。

**项目概览**
- 目标：在浏览器端将扫描的彩色负片进行“物理正确”的转正，并提供基础调色与导出能力。
- 技术栈：原生 HTML/CSS/JS + WebGL2（GPU）+ Canvas2D（CPU 分析）。
- 关键思想：所有与“色罩/密度/染料串扰”相关的处理都在**光学密度域**完成，而不是线性 RGB 域。

**目录结构**
- `index.html`：页面结构与控件布局。
- `filmlab.css`：UI 视觉风格与交互样式。
- `app.js`：状态管理、事件绑定、渲染调度、直方图绘制。
- `filmAnalyzer.js`：CPU 端底片特性分析（色罩、胶片类型、密度缩放、白平衡）。
- `glRenderer.js`：WebGL2 渲染器与负片转正 Shader。

**运行方式**
- 直接用浏览器打开 `index.html` 即可使用（需支持 WebGL2）。

**核心流程（从上传到渲染）**
1. 用户上传图片。
2. `GLRenderer.uploadImage()` 将图片上传到 GPU 并设置画布尺寸。
3. 同时将图片缩放绘制到 `cpuCanvas`（长边约 600px）用于分析。
4. `analyzeFilm()` 返回色罩、胶片类型、密度缩放、白平衡等参数。
5. `renderer.render()` 用分析参数 + 用户滑块参数执行 GPU 转正。
6. 每帧渲染后，从左下角小块区域采样像素绘制直方图。

**模块说明**

**`app.js`（UI 与状态机）**
- 维护 `state`：
  - 由分析得到的 `maskRaw / maskAdj / densityScale / crossMat / wb / filmType`。
  - 用户调节参数 `exp / con / temp / tint / sat / gamma`。
- `runAnalysis()`：调用 `analyzeFilm()` 并同步滑块与 Debug 面板。
- `render()`：将状态参数喂给 `GLRenderer`，并绘制直方图。
- 交互：文件上传、Tab 切换、滑块绑定、重分析、导出弹窗。
- 直方图：只读取左下角小区域像素，成本极低。

**`filmAnalyzer.js`（CPU 分析）**
- `estimateBaseDensity()`：
  - 统计亮度直方图，取最亮 0.5% 的像素作为片基颜色。
  - 得到色罩透过率（mask RGB）。
- `detectFilmType()`：
  - 基于 `R/G/B` 差异判断 `c41_color / c41_expired / bw_or_slide`。
- `getCrosstalkMatrix()`：
  - 返回 CMY 染料串扰校正矩阵（列主序，供 WebGL 使用）。
- `computeDensityScale()`：
  - 在密度域统计每个通道的有效范围，按 0.5%~99.5% 分位点拉伸。
- `computeWhiteBalance()`：
  - 在去色罩 + gamma 后的线性域，寻找中间调灰色像素做灰世界白平衡。
  - 采用多个饱和度阈值，保证足够采样量。

**`glRenderer.js`（GPU 渲染）**
- 初始化 WebGL2、全屏四边形、纹理与 Uniform。
- Fragment Shader 负片转正流程（密度域）：
  - 读取像素并 `-log()` 进入密度域。
  - 减去色罩基底密度（Orange Mask Subtraction）。
  - 串扰校正矩阵解耦 CMY 吸收。
  - 进行密度拉伸（Levels）。
  - 应用胶片 Gamma、白平衡、色温/色调、曝光、对比度、饱和度。
  - 转回 sRGB 输出。

**`index.html` + `filmlab.css`（界面与交互）**
- 结构上分为工作区（图像 + 直方图）、控制区（按钮、Tab、面板）。
- BASIC / FILM / DEBUG 三个面板分别对应：
  - 基础调色、胶片/色罩参数、调试信息可视化。
- 移动端友好：`100dvh`、安全区、触控优化、长按保存提示等。

**可调参数说明（BASIC / FILM）**
- Exposure（EV）：物理意义的乘法曝光补偿。
- Contrast：围绕 0.5 的线性拉伸，影响画面通透感。
- Temp / Tint：线性域加法微调，修正偏色。
- Saturation：按 Rec.709 亮度系数进行饱和度插值。
- Gamma：模拟胶片 H&D 曲线的趾部特性。
- Mask RGB：色罩透过率（绝对值），对应片基厚度。

**关键实现要点**
- 色罩处理必须在密度域相减，线性域相除是不正确的物理模型。
- `maskAdj` 始终保持“绝对值”，渲染时不再额外乘法，避免偏色失控。
- CPU 分析只对缩放后的图像进行，保证速度与稳定性。

**常见扩展方向**
- 增加 LUT 或曲线编辑器。
- 支持批量处理与多张导出。
- 按品牌/胶片型号切换更精确的串扰矩阵。

