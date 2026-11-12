# zcode-chat 待办 / 备忘

## 精灵 3D 化（VRM）：暂不做，以后可能做

> 2025-06 讨论结论：Chat 页精灵**主线保持 Live2D**（pixi + pixi-live2d-display + Cubism core）。
> 真 3D 作为以后的实验性方向先记下，**授权问题不用考虑**（已拍板）。

### 若以后做：技术选型

- 路线：three.js + `@pixiv/three-vrm`，VRM/VRoid 生态模型
- 形态：设置里的实验性开关，默认关闭；three-vrm 与模型资源同样**懒加载**（应用内已有先例：功能脚本按需加载）
- 与 Live2D 并存，不动现有架构

### 届时的评估要点

1. **小尺寸视觉**：300px 左右的小窗里，模型需 MToon 卡通渲染 + 灯光调好，否则脸部观感不如 Live2D 手绘清晰
2. **性能**：VRM 模型普遍 10–50MB（含贴图），three.js + 骨骼动画 + spring bone 的常驻开销高于 pixi 方案；chatView 页面同时还要跑 markdown 渲染
3. **开发成本**：VRM 路线需自己接动画（VRMA）、表情 blendshape 映射、lookAt；Live2D 的 motion/表情/hit-area 是模型自带元数据，一行就能播
4. **交互对齐**：至少补齐现有能力——眨眼/呼吸 idle、点击 tap motion + 气泡、任务派发/完成的表情反应、久未说话主动搭话

### Live2D 主线上更便宜的提升（优先做）

- [ ] 更丰富的 idle motion / 高质量模型（模型库扩充进行中）
- [ ] 任务状态表情联动：长任务 worried、完成 smile（模型自带 expression）
- [ ] 以后接 TTS 时加口型同步
