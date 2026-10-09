// Design System Components
// 统一的UI组件库

import './components.css';
import { ReactNode } from 'react';

/* === Button 按钮 === */
interface ButtonProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  onClick,
  icon,
}: ButtonProps) {
  return (
    <button
      className={`ds-button ${variant} ${size}`}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? (
        <span className="button-spinner" />
      ) : icon ? (
        <span className="button-icon">{icon}</span>
      ) : null}
      <span>{children}</span>
    </button>
  );
}

/* === Card 卡片 === */
interface CardProps {
  children: ReactNode;
  title?: string;
  description?: string;
  variant?: 'default' | 'elevated' | 'bordered';
}

export function Card({ children, title, description, variant = 'default' }: CardProps) {
  return (
    <div className={`ds-card ${variant}`}>
      {title && (
        <div className="ds-card-header">
          <h3 className="ds-card-title">{title}</h3>
          {description && <p className="ds-card-description">{description}</p>}
        </div>
      )}
      <div className="ds-card-content">{children}</div>
    </div>
  );
}

/* === Badge 徽章 === */
interface BadgeProps {
  children: ReactNode;
  variant?: 'success' | 'warning' | 'error' | 'info';
  size?: 'sm' | 'md';
}

export function Badge({ children, variant = 'info', size = 'md' }: BadgeProps) {
  return <span className={`ds-badge ${variant} ${size}`}>{children}</span>;
}

/* === Progress 进度条 === */
interface ProgressProps {
  value: number; // 0-100
  label?: string;
  showPercentage?: boolean;
}

export function Progress({ value, label, showPercentage = true }: ProgressProps) {
  return (
    <div className="ds-progress">
      {label && (
        <div className="ds-progress-header">
          <span className="ds-progress-label">{label}</span>
          {showPercentage && <span className="ds-progress-value">{value}%</span>}
        </div>
      )}
      <div className="ds-progress-track">
        <div className="ds-progress-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/* === Toast 通知 === */
interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  duration?: number;
  onClose?: () => void;
}

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  return (
    <div className={`ds-toast ${type}`}>
      <div className="ds-toast-icon">
        {type === 'success' && '✓'}
        {type === 'error' && '✕'}
        {type === 'info' && 'ℹ'}
      </div>
      <span className="ds-toast-message">{message}</span>
      {onClose && (
        <button className="ds-toast-close" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}

/* === Input 输入框 === */
interface InputProps {
  label?: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'email';
  disabled?: boolean;
  error?: string;
  hint?: string;
}

export function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  error,
  hint,
}: InputProps) {
  return (
    <div className="ds-input-group">
      {label && <label className="ds-input-label">{label}</label>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`ds-input ${error ? 'error' : ''}`}
      />
      {error && <span className="ds-input-error">{error}</span>}
      {hint && !error && <span className="ds-input-hint">{hint}</span>}
    </div>
  );
}

/* === Select 下拉选择 === */
interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({ label, value, onChange, options, placeholder }: SelectProps) {
  return (
    <div className="ds-input-group">
      {label && <label className="ds-input-label">{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ds-select"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* === Spinner 加载动画 === */
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className={`ds-spinner ${size}`}>
      <div className="ds-spinner-ring" />
      <div className="ds-spinner-ring" />
      <div className="ds-spinner-ring" />
    </div>
  );
}

/* === Divider 分割线 === */
export function Divider({ text }: { text?: string }) {
  return (
    <div className="ds-divider">
      {text ? (
        <>
          <span className="ds-divider-line" />
          <span className="ds-divider-text">{text}</span>
          <span className="ds-divider-line" />
        </>
      ) : (
        <span className="ds-divider-line full" />
      )}
    </div>
  );
}

/* === EmptyState 空状态 === */
interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = '📦', title, description, action }: EmptyStateProps) {
  return (
    <div className="ds-empty-state">
      <div className="ds-empty-icon">{icon}</div>
      <h3 className="ds-empty-title">{title}</h3>
      {description && <p className="ds-empty-description">{description}</p>}
      {action && <div className="ds-empty-action">{action}</div>}
    </div>
  );
}

/* === Stats 统计卡片 === */
interface StatProps {
  label: string;
  value: string | number;
  icon?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export function Stat({ label, value, icon, trend }: StatProps) {
  return (
    <div className="ds-stat">
      {icon && <div className="ds-stat-icon">{icon}</div>}
      <div className="ds-stat-content">
        <div className="ds-stat-value">{value}</div>
        <div className="ds-stat-label">{label}</div>
        {trend && (
          <div className={`ds-stat-trend ${trend.isPositive ? 'positive' : 'negative'}`}>
            {trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
          </div>
        )}
      </div>
    </div>
  );
}

/* === Alert 提示框 === */
interface AlertProps {
  type?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: ReactNode;
  onClose?: () => void;
}

export function Alert({ type = 'info', title, children, onClose }: AlertProps) {
  return (
    <div className={`ds-alert ${type}`}>
      <div className="ds-alert-icon">
        {type === 'success' && '✓'}
        {type === 'error' && '✕'}
        {type === 'warning' && '⚠'}
        {type === 'info' && 'ℹ'}
      </div>
      <div className="ds-alert-content">
        {title && <div className="ds-alert-title">{title}</div>}
        <div className="ds-alert-description">{children}</div>
      </div>
      {onClose && (
        <button className="ds-alert-close" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}

/* === Tabs 标签页 === */
interface Tab {
  id: string;
  label: string;
  content: ReactNode;
  badge?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="ds-tabs">
      <div className="ds-tabs-list">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`ds-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="ds-tab-badge">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>
      <div className="ds-tabs-content">
        {tabs.find((t) => t.id === activeTab)?.content}
      </div>
    </div>
  );
}

/* === FileUpload 文件上传 === */
interface FileUploadProps {
  onUpload: (file: File) => void;
  accept?: string;
  maxSize?: number; // MB
  disabled?: boolean;
}

export function FileUpload({
  onUpload,
  accept = 'image/jpeg,image/png',
  maxSize = 10,
  disabled = false,
}: FileUploadProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > maxSize * 1024 * 1024) {
      alert(`文件大小不能超过 ${maxSize}MB`);
      return;
    }

    onUpload(file);
  };

  return (
    <div className={`ds-file-upload ${disabled ? 'disabled' : ''}`}>
      <input
        type="file"
        accept={accept}
        onChange={handleChange}
        disabled={disabled}
        className="ds-file-input"
      />
      <div className="ds-file-upload-content">
        <div className="ds-file-upload-icon">📁</div>
        <div className="ds-file-upload-text">
          <strong>拖拽文件到这里</strong>
          <span>或点击选择文件</span>
        </div>
        <div className="ds-file-upload-hint">
          支持 {accept.split(',').join(', ')}，最大 {maxSize}MB
        </div>
      </div>
    </div>
  );
}
