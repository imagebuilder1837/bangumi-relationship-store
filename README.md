# Bangumi 好友关系存储

为 Bangumi 组件提供可共享的好友/反向好友关系缓存与读写协议。

## 使用

本项目供组件引用，不是可独立安装的组件或用户脚本，也不负责请求原站数据。

同一 Git 托管命名空间下，可用相对地址接入 Git submodule：

```sh
git submodule add ../bangumi-relationship-store.git vendor/bangumi-relationship-store
```

从 `src/index.mjs` 导入 `createRelationshipStore`，随组件一起打包。同一浏览器存储分区、同源的组件共享同一份 IndexedDB 缓存。

接口与协议见 [行为规格](docs/spec.md)，开发与验证见 [开发指南](docs/development.md)。

## License

本项目基于 MIT License 开源。详见 [LICENSE](LICENSE) 文件。
