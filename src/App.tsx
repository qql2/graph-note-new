import React, { useState, useEffect } from 'react';
import { Redirect, Route } from 'react-router-dom';
import { IonApp, IonRouterOutlet, setupIonicReact, useIonAlert, useIonToast } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Capacitor } from '@capacitor/core';
import SqliteService from './services/sqliteService';
import DbVersionService from './services/dbVersionService';
import StorageService  from './services/storageService';
import AppInitializer from './components/AppInitializer/AppInitializer';
import graphDatabaseService from './services/graph-database/GraphDatabaseService';
import { ThemeService } from './services/ThemeService';
import { ConfigService } from './services/ConfigService';

import UsersPage from './pages/UsersPage/UsersPage';
import GraphDBDemo from './pages/GraphDBDemo';
import GraphViewDemo from './pages/GraphViewDemo';
import SearchPage from './pages/SearchPage';
import DatabaseManagement from './pages/DatabaseManagement';
import AppMenu from './components/AppMenu/AppMenu';
import { SearchModal } from './components/search';
import { GraphNode, GraphEdge } from './models/GraphNode';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

/* Theme variables */
import './theme/variables.css';

export const platform = Capacitor.getPlatform();

// 自定义事件类型
export const DATA_IMPORT_SUCCESS_EVENT = 'data-import-success';

// 创建数据库服务的上下文
export const SqliteServiceContext = React.createContext(SqliteService);
export const DbVersionServiceContext = React.createContext(DbVersionService);
export const StorageServiceContext = React.createContext(new StorageService(SqliteService,DbVersionService));

setupIonicReact();

const App: React.FC = () => {
  const [presentToast] = useIonToast();
  const [presentAlert] = useIonAlert();
  // 搜索模态框控制状态
  const [showSearchModal, setShowSearchModal] = useState(false);
  // 加载应用配置
  const viewConfig = ConfigService.loadViewConfig();
  // 开发者模式状态
  const [developerMode, setDeveloperMode] = useState(viewConfig.developerMode);

  // 初始化主题
  useEffect(() => {
    ThemeService.initTheme();
  }, []);

  // 监听配置变化，更新开发者模式状态
  useEffect(() => {
    const checkConfig = () => {
      const config = ConfigService.loadViewConfig();
      setDeveloperMode(config.developerMode);
    };
    
    // 每秒检查一次配置
    const intervalId = setInterval(checkConfig, 1000);
    
    return () => {
      clearInterval(intervalId);
    };
  }, []);

  // Function to create a new node
  const handleCreateNode = async () => {
    // Initialize the database if not already initialized
    try {
      await graphDatabaseService.initialize({
        dbName: 'graph_demo',
        version: 1,
        verbose: true
      });
      
      const db = graphDatabaseService.getDatabase();
      
      // 加载视图配置
      const viewConfig = ConfigService.loadViewConfig();
      
      // Show dialog to input node label
      presentAlert({
        header: '创建独立节点',
        inputs: [
          {
            name: 'label',
            type: 'text',
            placeholder: '节点名称'
          },
        ],
        buttons: [
          {
            text: '取消',
            role: 'cancel'
          },
          {
            text: '创建',
            handler: async (data) => {
              if (!data.label || data.label.trim() === '') {
                presentToast({
                  message: '节点名称不能为空',
                  duration: 2000,
                  color: 'warning'
                });
                return;
              }
              
              try {
                // Create a new node with the provided label
                const nodeId = await db.addNode({
                  type: 'knowledge',
                  label: data.label.trim()
                });
                
                presentToast({
                  message: `成功创建节点：${data.label}`,
                  duration: 2000,
                  color: 'success'
                });
                
                // 根据配置决定是否自动跳转到新节点
                if (viewConfig.autoFocusNewNode) {
                  // 通过URL参数传递新创建的节点ID，并标记为新节点
                  window.location.href = `/graph-view-demo?node=${nodeId}&new=true`;
                } else {
                  // 如果不自动聚焦，则只跳转到图视图页面，不传递节点ID
                  window.location.href = `/graph-view-demo`;
                }
              } catch (error) {
                console.error('创建节点失败:', error);
                presentToast({
                  message: `创建节点失败: ${error instanceof Error ? error.message : String(error)}`,
                  duration: 3000,
                  color: 'danger'
                });
              }
            }
          }
        ]
      });
    } catch (error) {
      console.error('初始化数据库失败:', error);
      presentToast({
        message: `初始化数据库失败: ${error instanceof Error ? error.message : String(error)}`,
        duration: 3000,
        color: 'danger'
      });
    }
  };

  // 搜索节点和关系
  const handleSearch = () => {
    // 显示搜索模态框，而不是导航到搜索页面
    setShowSearchModal(true);
  };

  // 处理模态框关闭
  const handleCloseSearchModal = () => {
    setShowSearchModal(false);
  };

  // 处理搜索结果中的节点选择
  const handleNodeSelect = (node: GraphNode) => {
    // 关闭搜索模态框
    setShowSearchModal(false);
    // 跳转到图形视图页面，显示选中的节点
    window.location.href = `/graph-view-demo?node=${node.id}`;
  };

  // 处理搜索结果中的关系选择
  const handleEdgeSelect = (edge: GraphEdge) => {
    // 关闭搜索模态框
    setShowSearchModal(false);
    // 跳转到图形视图页面，显示关系的源节点
    window.location.href = `/graph-view-demo?node=${edge.source}`;
  };

  // 处理数据导入成功
  const handleImportSuccess = () => {
    // 创建并分发一个自定义事件，通知GraphViewDemo页面刷新数据
    const event = new CustomEvent(DATA_IMPORT_SUCCESS_EVENT);
    window.dispatchEvent(event);
  };

  // 添加处理检查数据库状态的函数
  const handleCheckDbStatus = () => {
    // 创建一个新的自定义事件，用于通知当前页面检查数据库状态
    const event = new CustomEvent('check-db-status-event');
    window.dispatchEvent(event);
  };

  // 添加处理手动提交事务的函数
  const handleCommitTransaction = () => {
    // 创建一个新的自定义事件，用于通知当前页面手动提交事务
    const event = new CustomEvent('commit-transaction-event');
    window.dispatchEvent(event);
  };

  // 只有在开发者模式下才允许访问的路由守卫组件
  const DeveloperRouteGuard = ({ component: Component, ...rest }: any) => (
    <Route
      {...rest}
      render={(props) =>
        developerMode ? (
          <Component {...props} />
        ) : (
          <Redirect to="/graph-view-demo" />
        )
      }
    />
  );

  return (
    <SqliteServiceContext.Provider value={SqliteService}>
      <DbVersionServiceContext.Provider value={DbVersionService}>
        <StorageServiceContext.Provider value={new StorageService(SqliteService,DbVersionService)}>
          <AppInitializer>
            <IonApp>
              <IonReactRouter>
                <AppMenu 
                  onCreateNode={handleCreateNode} 
                  onSearch={handleSearch}
                  onImportSuccess={handleImportSuccess}
                  onCheckDbStatus={handleCheckDbStatus}
                  onCommitTransaction={handleCommitTransaction}
                  developerMode={developerMode}
                />
                {/* 搜索模态框 */}
                <SearchModal 
                  isOpen={showSearchModal}
                  onClose={handleCloseSearchModal}
                  onSelectNode={handleNodeSelect}
                  onSelectEdge={handleEdgeSelect}
                />
                <IonRouterOutlet id="main-content">
                  <Route exact path="/">
                    <Redirect to="/graph-view-demo" />
                  </Route>
                  <DeveloperRouteGuard path="/users" component={UsersPage} />
                  <DeveloperRouteGuard path="/graph-demo" component={GraphDBDemo} />
                  <DeveloperRouteGuard path="/database-management" component={DatabaseManagement} />
                  <Route path="/graph-view-demo" component={GraphViewDemo} />
                  <Route path="/search" component={SearchPage} />
                </IonRouterOutlet>
              </IonReactRouter>
            </IonApp>
          </AppInitializer>
        </StorageServiceContext.Provider>
      </DbVersionServiceContext.Provider>
    </SqliteServiceContext.Provider>
  )
};

export default App;
