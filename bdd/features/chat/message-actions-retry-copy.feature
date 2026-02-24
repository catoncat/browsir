@contract(BHV-CHAT-MESSAGE-ACTIONS-RETRY-COPY)
Feature: Assistant message actions retry and copy

  Scenario: user 消息支持 inline 编辑并重跑入口
    Given sidepanel 已存在 user 消息与 assistant 回复
    When 用户点击该 user 消息上的 "编辑并重跑" icon
    Then 该 user 气泡应进入 inline 编辑态
    And 焦点应落在该消息内的编辑输入框
    And 底部输入框内容不应被回填覆盖

  Scenario: 编辑最后一条 user 在当前会话原地重跑
    Given sidepanel 当前分支最后一条 user 消息可编辑
    When 用户在该消息 inline editor 提交修改
    Then 应触发当前会话重跑而不新建会话
    And 应显示重跑占位动画

  Scenario: 编辑历史 user 触发分叉并重跑
    Given sidepanel 当前会话存在可编辑的历史 user 消息
    When 用户在历史消息 inline editor 提交修改
    Then 应创建新分叉会话并切换过去
    And 应显示分叉重跑占位动画

  Scenario: assistant 消息渲染复制与分叉 icon，最后一条显示重试
    Given sidepanel 已存在 assistant 消息
    When 用户查看该 assistant 消息
    Then 应看到 aria-label 为 "复制内容" 的 icon 按钮
    And 应看到 aria-label 为 "在新对话中分叉" 的 icon 按钮
    And 应看到 aria-label 为 "重新回答" 的 icon 按钮

  Scenario: 历史 assistant 消息触发分叉新会话
    Given sidepanel 同一会话存在至少两条 assistant 消息
    When 用户点击较早一条 assistant 消息上的 "在新对话中分叉" icon
    Then 应触发分叉流程而不是被禁用
    And 应提示 "已分叉到新对话"
    And 会话列表应新增一个分支会话
    And 新分支会话应包含 fork 来源信息

  Scenario: 点击复制触发成功反馈
    Given sidepanel 已存在 assistant 消息
    When 用户点击 "复制内容" icon
    Then 应出现 "已复制" 的反馈状态

  Scenario: 最后一条 assistant 的重试在当前会话执行
    Given sidepanel 已存在最后一条 assistant 消息且存在前序 user 消息
    When 用户点击最后一条 assistant 消息上的 "重新回答" icon
    Then 应提示 "已发起重新回答"
    And 当前会话数量应保持不变
    And 应出现新的 assistant 回复

  Scenario: clipboard 不可用时显示降级提示
    Given sidepanel 已存在 assistant 消息
    And clipboard 写入在当前上下文不可用
    When 用户点击 "复制内容" icon
    Then 应显示复制失败提示
    And 页面与会话流程保持可用
