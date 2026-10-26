#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""词典分片构建入口。

实际构建器为 build_chunks.js：完整 dict.js 是 JavaScript 单引号对象，
用 Node 的真实 JS 解析器读取，避免 Python 正则解析破坏转义字符。

运行：python build_chunks.py
输出：chunks/en/*.js、chunks/zh/*.js、chunks/index.json、chunks/zh-index.json
"""
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
subprocess.run(['node', os.path.join(HERE, 'build_chunks.js')], cwd=HERE, check=True)
