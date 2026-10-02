// Application Core（Domain / Application / Ports）の public API はここだけで公開する。
// 中身は PoC 実装（PR2 / Issue #3）で追加する。core は Framework / Runtime 非依存とし、
// playwright・aws-sdk・appium 等を持ち込まない（ADR-0006）。
export {}
