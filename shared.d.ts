type Edit = {
  color: string;
  size: number;
  from: number[];
  to: number[];
};

type ImageMessage = {
  logicalTime: number;
  imageData: string;
};