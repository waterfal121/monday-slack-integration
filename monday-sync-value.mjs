// 每次執行程式前需要先執行 ngrok http 3000 建立 public URL
// 並於 monday.com 的 source board 的 automation center 設定 webhook 指向該 public URL

// monday API document 提供清除欄位值的方法：
// 1. change_simple_cloumn_value, value: "";
// 2. change_column_value, value: "{}";
// (https://developer.monday.com/api-reference/docs/change-column-values#removing-column-values)
// 但以上沒有通用的清除欄位的方法，需要針對不同的欄位格式進行處理。
// monday.com schema (https://api.monday.com/v2/get_schema)

// 當前版本可以成功清除欄位值。

import express from 'express';
import axios from 'axios';
import 'dotenv/config';

const slackToken = process.env.SLACK_BOT_TOKEN;
const mondayApiKey = process.env.MONDAY_API_KEY;
const slackChannelId = process.env.SLACK_CHANNEL_ID;
const app = express();
app.use(express.json());

// 環境變數檢查
checkEnvVars(['MONDAY_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']);

app.get('/', (req, res) => {
  res.status(200).send('monday-sync-value, server is running!');
});

// /monday-webhook 路由
app.post('/monday-webhook', async (req, res) => {
  try {
    const { challenge } = req.body;
    if (challenge) return res.status(200).send({ challenge });

    if (!req.body.event) {
      return res
        .status(400)
        .send('Invalid webhook payload: Missing event data');
    }

    const { event } = req.body;
    const { boardId, pulseId, columnId } = req.body.event; // pulseId 為 itemId
    if (!boardId || !pulseId || !columnId) {
      return res
        .status(400)
        .send('Invalid webhook payload: Missing required fields');
    }
    console.log(
      `Received webhook: board_id=${boardId}, item_id=${pulseId}, column_id=${columnId}`
    );

    // Step 1: 查詢更新欄位的相關資料
    const query = `
      query {
        items(ids: ${pulseId}) {
          name
          column_values(ids: "${columnId}") {
            column{
              title
            }
            value
          }
        }
      }
    `;
    const queryResponse = await mondayOperate(query);
    // 取得board A itemName與columnName，用來取得board B itemId與columnId
    const itemName = queryResponse.data.data.items[0].name;
    const columnName =
      queryResponse.data.data.items[0].column_values[0].column.title;
    // 處理 value
    const rawValue = queryResponse.data.data.items[0].column_values[0].value;
    let columnValue;
    if (rawValue) {
      try {
        columnValue = JSON.parse(rawValue);
      } catch (error) {
        console.error('Failed to parse column value:', rawValue, error);
        return res.status(500).send('Error parsing column value');
      }
    } else {
      columnValue = rawValue; // 可能為 null，確保程式不會中斷
    }
    console.log(`[Step 1] Fetched value: `, columnValue);

    // query target board 取得 itemId 與 columnId
    const targetBoardId = 1950371245; // target Board 的 ID (board B)
    const queryTargetBoard = `
      query{
        boards(ids: ${targetBoardId}) {
          items_page {
            items {
              id
              name
            }
          }
          columns {
            id
            title
          }
        }
      }
    `;

    const targetQueryResponse = await mondayOperate(queryTargetBoard);
    const targetItems = // target board 的所有 items
      targetQueryResponse.data.data.boards[0].items_page.items;
    const targetColumns = targetQueryResponse.data.data.boards[0].columns; // target board 的所有 columns
    console.log('target items: ', targetItems);
    console.log('target columns: ', targetColumns);

    // 根據 source board 的 item name 對應 target board 的目標 item
    const targetItem = targetItems.find((item) => item.name === itemName);
    if (!targetItem) {
      console.error(`No matching item found in Board B for name: ${itemName}`);
      return;
    }
    const targetItemId = targetItem.id; // 取得 target board item id

    // 根據 source board 的 column title 對應 target board 的目標 column
    const targetColumn = targetColumns.find((col) => col.title === columnName);
    if (!targetColumn) {
      console.error(
        `No matching column found in Board B for title: ${columnName}`
      );
      return;
    }
    const targetColumnId = targetColumn.id; // 取得 target board column id

    // Step 2: 將更新的資料 mutation 到 target board
    // 1. 有值
    const mutation = `
      mutation {
        change_column_value(
          board_id: ${targetBoardId},
          item_id: ${targetItemId},
          column_id: "${targetColumnId}",
          value: "${escapeForGraphQL(columnValue)}"
        ) {
          id
        }
      }
    `;
    // 2. value為null時，清除欄位
    // 2.1 simple value
    const removeSimpleValue = `
      mutation {
        change_simple_column_value(
          board_id: ${targetBoardId},
          item_id: ${targetItemId},
          column_id: "${targetColumnId}",
          value: ""
        ) {
          id
        }
      }
    `;
    // 2.2 not a simple value
    const removeValue = `
    mutation {
        change_column_value(
          board_id: ${targetBoardId},
          item_id: ${targetItemId},
          column_id: "${targetColumnId}",
          value: "{}"
        ) {
          id
        }
      }
    `;
    let mutationResponse;
    if (rawValue === null) {
      if (targetColumn.title === 'Timeline') {
        mutationResponse = await mondayOperate(removeValue);
        return;
      }
      mutationResponse = await mondayOperate(removeSimpleValue);
      return;
    }
    mutationResponse = await mondayOperate(mutation);

    console.log(
      `[Step 2] Updated value in target board:`,
      mutationResponse.data
    );
    res.status(200).send('Success');
  } catch (error) {
    console.error(
      'Error processing webhook:',
      error.response?.data || error.message
    );
    res.status(500).send('Failed to process webhook');
  }
});

// 全局錯誤處理
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function mondayOperate(method) {
  return await axios.post(
    'https://api.monday.com/v2',
    { query: method },
    { headers: { Authorization: mondayApiKey } }
  );
}

// 環境變數檢查
function checkEnvVars(vars) {
  vars.forEach((key) => {
    if (!process.env[key]) {
      console.error(`Environment variable ${key} is missing.`);
      process.exit(1);
    }
  });
}

// 將值轉換成 GraphQL JSON string
function escapeForGraphQL(value) {
  return JSON.stringify(value).replace(/"/g, '\\"');
}

// 啟動伺服器
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
