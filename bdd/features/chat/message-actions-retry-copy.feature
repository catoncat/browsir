@contract(BHV-CHAT-MESSAGE-ACTIONS-RETRY-COPY)
Feature: Assistant message actions retry and copy

  Scenario: assistant 消息渲染复制与重答 icon
    Given sidepanel 已存在 assistant 消息
    When 用户查看该 assistant 消息
    Then 应看到 aria-label 为 "复制内容" 的 icon 按钮
    And 应看到 aria-label 为 "重新回答" 的 icon 按钮

  Scenario: 点击复制触发成功反馈
    Given sidepanel 已存在 assistant 消息
    When 用户点击 "复制内容" icon
    Then 应出现 "已复制" 的反馈状态

  Scenario: 点击重答触发新一轮 assistant 回答
    Given sidepanel 已存在 assistant 消息且存在前序 user 消息
    When 用户点击 "重新回答" icon
    Then 会话消息数量应增长
    And 应出现新的 assistant 回复

  Scenario: clipboard 不可用时显示降级提示
    Given sidepanel 已存在 assistant 消息
    And clipboard 写入在当前上下文不可用
    When 用户点击 "复制内容" icon
    Then 应显示复制失败提示
    And 页面与会话流程保持可用
