// Vite emits a standalone worker asset; the import is its public URL.
declare module '*?worker&url' {
  const url: string;
  export default url;
}
