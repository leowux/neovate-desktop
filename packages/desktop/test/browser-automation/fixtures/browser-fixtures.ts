export const SAMPLE_AX_TREE = [
  {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "Checkout" },
    backendDOMNodeId: 100,
    childIds: ["heading", "email", "submit", "iframe"],
  },
  {
    nodeId: "heading",
    role: { value: "heading" },
    name: { value: "Checkout form" },
    backendDOMNodeId: 110,
  },
  {
    nodeId: "email",
    role: { value: "textbox" },
    name: { value: "Email" },
    value: { value: "user@example.com" },
    backendDOMNodeId: 120,
    focused: true,
  },
  {
    nodeId: "submit",
    role: { value: "button" },
    name: { value: "Submit order" },
    backendDOMNodeId: 130,
  },
  {
    nodeId: "iframe",
    role: { value: "Iframe" },
    name: { value: "payment-frame" },
    backendDOMNodeId: 140,
    childIds: ["card", "pay"],
  },
  {
    nodeId: "card",
    role: { value: "textbox" },
    name: { value: "Card number" },
    backendDOMNodeId: 210,
    focused: true,
  },
  {
    nodeId: "pay",
    role: { value: "button" },
    name: { value: "Pay" },
    backendDOMNodeId: 220,
  },
] as const;

export const SAMPLE_FRAME_TREE = {
  frame: {
    id: "main-frame",
    url: "https://shop.example.com/checkout",
    name: "main",
  },
  childFrames: [
    {
      frame: {
        id: "payment-frame",
        url: "https://pay.example.com/frame",
        name: "payment-frame",
        parentId: "main-frame",
      },
    },
  ],
} as const;

export const SAMPLE_BOX_MODEL = {
  content: [10, 20, 110, 20, 110, 60, 10, 60],
  width: 100,
  height: 40,
} as const;
